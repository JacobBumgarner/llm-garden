import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActionLog, labelFor, TAIL_LINES, tailOf } from "../extensions/log.ts";
import type { ToolItem } from "../extensions/types.ts";

function final(text: string, isError = false): ToolItem["result"] {
	return { text, details: undefined, isError };
}

describe("tailOf", () => {
	it("keeps the last non-blank lines, capped", () => {
		const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n\n");
		const tail = tailOf({ name: "bash", args: {}, result: final(text) });
		assert.equal(tail.length, TAIL_LINES);
		assert.deepEqual(tail.at(-1), "line 11");
	});
	it("shows the end of the diff for an edit", () => {
		const diff = "-  1 old\n+  1 new";
		const tail = tailOf({ name: "edit", args: {}, result: { text: "", details: { diff }, isError: false } });
		assert.deepEqual(tail, ["-  1 old", "+  1 new"]);
	});
	it("is empty without a result", () => {
		assert.deepEqual(tailOf({ name: "bash", args: {} }), []);
	});
});

describe("labelFor", () => {
	it("takes the first non-blank line of a string or text blocks", () => {
		assert.equal(labelFor("\n\n  fix the tests \nmore"), "fix the tests");
		assert.equal(labelFor([{ type: "image" }, { type: "text", text: "hello\nworld" }]), "hello");
		assert.equal(labelFor(undefined), "");
	});
	it("clips long lines", () => {
		const label = labelFor("x".repeat(200));
		assert.equal(label.length, 120);
		assert.ok(label.endsWith("…"));
	});
});

describe("ActionLog", () => {
	it("groups calls by turn and reports the tail", () => {
		const log = new ActionLog();
		log.nextGroup();
		log.add("a", "read", { path: "x" });
		log.add("b", "bash", { command: "ls" });
		log.nextGroup();
		log.add("c", "read", { path: "y" });
		assert.equal(log.isGroupTail("a"), false);
		assert.equal(log.isGroupTail("b"), true);
		assert.equal(log.isGroupTail("c"), true);
		assert.equal(log.get("c")?.group, 2);
		assert.deepEqual(log.groupIds(1), ["a", "b"]);
	});

	it("counts top-level calls only, by status", () => {
		const log = new ActionLog(["subagent"]);
		log.nextGroup();
		log.start("a", "bash", {});
		log.start("b", "bash", {});
		log.start("c", "read", {}, "a");
		log.start("s", "subagent", {});
		log.result("a", final("", true));
		const count = log.groupCount(1);
		assert.deepEqual(count, { total: 2, running: 1, errors: 1, added: 0, removed: 0 });
		assert.equal(log.isGroupTail("s"), false);
		assert.equal(log.isGroupTail("c"), false);
		assert.equal(log.isGroupTail("b"), true);
	});

	it("sums lines added and removed across a group's edit diffs", () => {
		const log = new ActionLog();
		log.nextGroup();
		log.start("a", "edit", {});
		log.start("b", "edit", {});
		log.start("c", "bash", {});
		log.result("a", { text: "ok", details: { diff: "+one\n+two\n-three\n ctx" }, isError: false });
		log.result("b", { text: "ok", details: { diff: "-gone" }, isError: false });
		log.result("c", final("+not a diff"));
		assert.deepEqual(log.groupCount(1), { total: 3, running: 0, errors: 0, added: 2, removed: 2 });
	});

	it("puts nested calls in the parent's group and lists them after it", () => {
		const log = new ActionLog();
		log.nextGroup();
		log.add("a", "codemode", {});
		log.nextGroup();
		log.add("a/1", "read", {}, "a");
		assert.equal(log.get("a/1")?.group, 1);
		assert.deepEqual(
			log.all().map((entry) => entry.id),
			["a", "a/1"],
		);
	});

	it("tracks steps between pieces of assistant text, with their tails and counts", () => {
		const log = new ActionLog();
		log.nextGroup();
		log.start("a", "read", {});
		log.start("b", "read", {});
		log.nextStep();
		log.start("c", "bash", {});
		log.start("c/1", "read", {}, "c");
		assert.equal(log.get("c/1")?.step, 2);
		assert.equal(log.isStepTail("a"), false);
		assert.equal(log.isStepTail("b"), true);
		assert.equal(log.isStepTail("c"), true);
		assert.deepEqual(log.stepCount(1), { total: 2, running: 2, errors: 0, added: 0, removed: 0 });
		assert.deepEqual(log.stepCount(2), { total: 1, running: 1, errors: 0, added: 0, removed: 0 });
		log.closeGroup(1);
		assert.equal(log.isStepTail("c"), true);
		assert.equal(log.isGroupTail("c"), false);
	});

	it("closes a group so no call of it is the tail", () => {
		const log = new ActionLog();
		log.nextGroup();
		log.add("a", "read", {});
		assert.equal(log.isGroupTail("a"), true);
		log.closeGroup(1);
		assert.equal(log.isClosed(1), true);
		assert.equal(log.isGroupTail("a"), false);
		log.nextGroup();
		log.add("b", "read", {});
		assert.equal(log.isGroupTail("b"), true);
	});

	it("hides excluded tools from the panel listing", () => {
		const log = new ActionLog(["subagent"]);
		log.add("s", "subagent", {});
		log.add("a", "read", {});
		assert.deepEqual(
			log.visible().map((entry) => entry.id),
			["a"],
		);
	});

	it("records duration once on the final result and keeps partial tails", () => {
		const log = new ActionLog();
		log.start("a", "bash", {});
		log.result("a", { text: "one\ntwo", details: undefined, isError: false, partial: true });
		assert.equal(log.get("a")?.durationMs, undefined);
		assert.deepEqual(log.get("a")?.tail, ["one", "two"]);
		log.result("a", final("one\ntwo\nthree"), 1500);
		log.result("a", final("ignored"), 9000);
		assert.equal(log.get("a")?.durationMs, 1500);
		assert.deepEqual(log.get("a")?.tail, ["ignored"]);
	});

	it("notifies listeners once per changed entry, after the current task", async () => {
		const log = new ActionLog();
		const seen: string[] = [];
		log.onChange((entry) => seen.push(entry.id));
		log.start("a", "bash", {});
		log.result("a", final("ok"));
		log.start("b", "read", {});
		assert.deepEqual(seen, []);
		await Promise.resolve();
		assert.deepEqual(seen, ["a", "b"]);
		log.result("b", final("x"));
		await Promise.resolve();
		assert.deepEqual(seen, ["a", "b", "b"]);
	});

	it("adds live messages so unfinished calls tick", () => {
		const log = new ActionLog();
		log.addMessages(
			[
				{ role: "user", content: "do it" },
				{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } }] },
			],
			true,
		);
		assert.ok(log.get("a")?.startedAt !== undefined);
		assert.equal(log.label(1), "do it");
		log.addMessages([{ role: "toolResult", toolCallId: "a", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }], true);
		assert.ok(log.get("a")?.durationMs !== undefined);
	});

	it("seeds from a session branch", () => {
		const log = new ActionLog();
		const branch = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "looking" },
						{ type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "a",
					toolName: "read",
					content: [{ type: "text", text: "body" }],
					isError: false,
					durationMs: 40,
				},
			},
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "a2", name: "read", arguments: { path: "y" } }] },
			},
			{ type: "message", message: { role: "user", content: "next question" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } }] },
			},
		];
		log.seed(branch as never);
		assert.equal(log.get("a")?.group, 1);
		assert.equal(log.get("a")?.durationMs, 40);
		assert.deepEqual(log.get("a")?.tail, ["body"]);
		assert.equal(log.get("a2")?.group, 1);
		assert.equal(log.get("a")?.step, 2);
		assert.equal(log.get("a2")?.step, 2);
		assert.equal(log.isStepTail("a"), false);
		assert.equal(log.isStepTail("a2"), true);
		assert.equal(log.isGroupTail("a"), false);
		assert.equal(log.get("b")?.group, 2);
		assert.equal(log.currentGroup, 2);
		assert.equal(log.isClosed(1), true);
		assert.equal(log.isClosed(2), true);
		assert.equal(log.isGroupTail("b"), false);
		assert.deepEqual(log.groups(), [1, 2]);
		assert.equal(log.label(1), "hi");
		assert.equal(log.label(2), "next question");
		assert.equal(log.label(3), "");
		assert.deepEqual(log.groupCount(2), { total: 1, running: 1, errors: 0, added: 0, removed: 0 });
	});
});
