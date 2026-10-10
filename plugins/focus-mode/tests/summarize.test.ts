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

	it("shows an args-only subagent start as agent and label", () => {
		const args = { action: "start", agent: "scout", label: "Find the bug", task: "look" };
		assert.deepEqual(summarize(tool("subagent", args)), ["… subagent scout · Find the bug"]);
	});

	it("shows one line per task in a tasks array", () => {
		const tasks = [
			{ label: "Scan A", agent: "scout", task: "a" },
			{ label: "Scan B", agent: "worker", task: "b" },
		];
		assert.deepEqual(summarize(tool("subagent", { action: "start", tasks })), [
			"… subagent scout · Scan A",
			"… subagent worker · Scan B",
		]);
	});

	it("shows a wait call by action and ids", () => {
		assert.deepEqual(summarize(tool("subagent", { action: "wait", ids: ["a1", "b2"] })), ["… subagent wait a1 b2"]);
		assert.deepEqual(summarize(tool("subagent", { action: "stop", id: "a1", label: "Scan" })), [
			"… subagent stop a1 · Scan",
		]);
	});

	it("shows a running run with turns, tokens, cost, and its last tool", () => {
		const usage = { input: 12345, output: 1100, cost: 0.0412, turns: 2 };
		const run = { agent: "scout", label: "Find it", state: "running", usage, lastTool: { name: "bash", args: {} } };
		const partial = { text: "", details: { action: "start", view: "x", runs: [run] }, isError: false, partial: true };
		assert.deepEqual(summarize(tool("subagent", {}, partial)), [
			"… subagent scout · Find it · 2 turns · ↑12k ↓1.1k · $0.04 · → bash",
		]);
	});

	it("shows a done run with its state word and keeps turns and tokens", () => {
		const usage = { input: 12345, output: 1100, cost: 0.0412, turns: 2 };
		const run = { agent: "scout", label: "Find it", state: "done", usage, lastTool: { name: "bash", args: {} } };
		assert.deepEqual(summarize(tool("subagent", {}, done({ runs: [run] }))), [
			"subagent scout · Find it · 2 turns · ↑12k ↓1.1k · done",
		]);
	});

	it("marks a failed run with an error suffix, one line per run", () => {
		const runs = [
			{ agent: "scout", label: "One", state: "done", usage: { turns: 1, input: 10, output: 5 } },
			{ agent: "worker", label: "Two", state: "failed", usage: { turns: 3, input: 2000, output: 500 } },
		];
		assert.deepEqual(summarize(tool("subagent", {}, done({ runs }, true))), [
			"subagent scout · One · 1 turn · ↑10 ↓5 · done",
			"subagent worker · Two · 3 turns · ↑2.0k ↓500 · failed error",
		]);
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
