import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolItem } from "../extensions/types.ts";
import { summarize } from "../extensions/summarize.ts";

function tool(name: string, args: Record<string, unknown>, result?: ToolItem["result"]): ToolItem {
	return { name, args, result };
}

function done(details: unknown, isError = false): ToolItem["result"] {
	return { text: "", details, isError };
}

describe("summarize", () => {
	it("counts changed lines in the edit diff", () => {
		const diff = "     ...\n   6 context\n-  7 old\n+  7 new\n+  8 more\n   9 context";
		assert.deepEqual(summarize(tool("edit", { path: "f.ts" }, done({ diff }))), ["edit f.ts +2 -1"]);
	});

	it("shows write line count", () => {
		assert.deepEqual(summarize(tool("write", { path: "a.txt", content: "a\nb\nc\n" }, done(undefined))), [
			"write a.txt (3 lines)",
		]);
	});

	it("shows the first bash line and an error marker", () => {
		assert.deepEqual(summarize(tool("bash", { command: "ls\necho hi" }, done(undefined))), ["$ ls"]);
		assert.deepEqual(summarize(tool("bash", { command: "false" }, done(undefined, true))), ["$ false error"]);
	});

	it("shows key arguments for read, ls, grep, find", () => {
		assert.deepEqual(summarize(tool("read", { path: "a.ts" }, done(undefined))), ["read a.ts"]);
		assert.deepEqual(summarize(tool("ls", { path: "src" }, done(undefined))), ["ls src"]);
		assert.deepEqual(summarize(tool("grep", { pattern: "foo", path: "x" }, done(undefined))), ["grep foo"]);
		assert.deepEqual(summarize(tool("find", { pattern: "*.ts" }, done(undefined))), ["find *.ts"]);
	});

	it("renders one line per ask question", () => {
		const questions = [
			{ id: "a", question: "Which?", options: [{ label: "One" }, { label: "Two" }] },
			{ id: "b", question: "Name?" },
			{ id: "c", question: "Sure?", options: [{ label: "Yes" }] },
			{ id: "d", question: "Skipped?" },
		];
		const result = {
			answers: [
				{ id: "a", answer: { kind: "selected", indices: [0, 1] } },
				{ id: "b", answer: { kind: "text", text: "Bob" } },
				{ id: "c", answer: { kind: "clarify" } },
			],
			cancelled: false,
		};
		assert.deepEqual(summarize(tool("ask", {}, done({ questions, result }))), [
			"? Which? -> One, Two",
			"? Name? -> Bob",
			"? Sure? -> clarify",
			"? Skipped? -> unanswered",
		]);
		assert.deepEqual(summarize(tool("ask", {}, done({ questions, result: { answers: [], cancelled: true } }))), [
			"cancelled",
		]);
	});

	it("renders one line per subagent result with an error marker", () => {
		const details = {
			results: [
				{ agent: "scout", task: "find it", exitCode: 0 },
				{ agent: "worker", task: "do it", exitCode: 1 },
			],
		};
		assert.deepEqual(summarize(tool("subagent", {}, done(details))), [
			"subagent scout",
			"subagent worker error",
		]);
	});

	it("shows subagent turns, tokens, cost, and the running tool", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read" }] },
			{ role: "toolResult", content: [] },
			{ role: "assistant", content: [{ type: "text", text: "hm" }, { type: "toolCall", name: "bash" }] },
		];
		const usage = { input: 12345, output: 1100, cost: 0.0412, turns: 2 };
		const running = { text: "", details: { results: [{ agent: "scout", task: "find it", usage, messages }] }, isError: false, partial: true };
		assert.deepEqual(summarize(tool("subagent", {}, running)), [
			"… subagent scout · 2 turns · ↑12k ↓1.1k · $0.04 · → bash",
		]);
		const finished = done({ results: [{ agent: "scout", task: "find it", exitCode: 0, usage, messages }] });
		assert.deepEqual(summarize(tool("subagent", {}, finished)), ["subagent scout · 2 turns · ↑12k ↓1.1k · $0.04"]);
	});

	it("falls back to name and first string argument", () => {
		assert.deepEqual(summarize(tool("mystery", { n: 1, q: "hello" }, done(undefined))), ["mystery hello"]);
		assert.deepEqual(summarize(tool("mystery", { n: 1 }, done(undefined))), ["mystery"]);
	});

	it("marks pending calls as running", () => {
		assert.deepEqual(summarize(tool("bash", { command: "sleep 1" })), ["… $ sleep 1"]);
		assert.deepEqual(summarize(tool("edit", { path: "f.ts" })), ["… edit f.ts"]);
		const partial = { text: "", details: undefined, isError: false, partial: true };
		assert.deepEqual(summarize(tool("read", { path: "a" }, partial)), ["… read a"]);
	});
});
