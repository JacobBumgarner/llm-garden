import assert from "node:assert/strict";
import { test } from "node:test";
import { type ParseResult, parseParams, type SubagentRequest } from "../extensions/params.ts";

const ok = (raw: Record<string, unknown>): SubagentRequest => {
	const result = parseParams(raw);
	assert.ok(result.ok, `expected ok, got: ${(result as { error?: string }).error}`);
	return result.request;
};

const error = (raw: Record<string, unknown>): string => {
	const result: ParseResult = parseParams(raw);
	assert.ok(!result.ok, `expected an error for ${JSON.stringify(raw)}`);
	return result.error;
};

test("start with agent and task fills the defaults", () => {
	assert.deepEqual(ok({ action: "start", label: "Go now", agent: "glm", task: "go" }), {
		action: "start",
		tasks: [{ label: "Go now", agent: "glm", task: "go" }],
		background: false,
		notify: "wake",
		agentScope: "user",
		confirmProjectAgents: true,
	});
});

test("start takes every option and applies cwd to tasks that name none", () => {
	assert.deepEqual(
		ok({
			action: "start",
			tasks: [{ label: "A", agent: "a", task: "x" }, { label: "B", agent: "b", task: "y", cwd: "/b" }],
			background: true,
			notify: "quiet",
			cwd: "/top",
			agentScope: "both",
			confirmProjectAgents: false,
		}),
		{
			action: "start",
			tasks: [
				{ label: "A", agent: "a", task: "x", cwd: "/top" },
				{ label: "B", agent: "b", task: "y", cwd: "/b" },
			],
			background: true,
			notify: "quiet",
			agentScope: "both",
			confirmProjectAgents: false,
		},
	);
});

test("start rejects both agent/task and tasks", () => {
	const err = error({ action: "start", agent: "a", task: "x", tasks: [{ label: "B", agent: "b", task: "y" }] });
	assert.match(err, /^action "start" takes label, agent and task, or tasks/);
	assert.match(err, /both agent\/task and tasks/);
});

test("start names the missing agent, task, or tasks entry field", () => {
	assert.match(error({ action: "start", label: "L", agent: "a" }), /Missing task\.$/);
	assert.match(error({ action: "start", label: "L", task: "x" }), /Missing agent\.$/);
	assert.match(error({ action: "start", label: "L" }), /Missing agent and task\.$/);
	assert.match(error({ action: "start", tasks: [] }), /tasks is empty/);
	assert.match(error({ action: "start", tasks: [{ label: "L", agent: "a" }] }), /tasks\[0\] is missing task/);
});

test("start without a label is rejected with the fix", () => {
	const err = error({ action: "start", agent: "a", task: "x" });
	assert.match(err, /Missing label\. To fix it, add a label, a 3 to 7 word title for the run\.$/);
	assert.match(error({ action: "start", label: "  ", agent: "a", task: "x" }), /Missing label/);
	assert.match(error({ action: "start" }), /Missing label, agent and task\./);
});

test("a tasks entry without a label is rejected with the fix", () => {
	const err = error({ action: "start", tasks: [{ label: "A", agent: "a", task: "x" }, { agent: "b", task: "y" }] });
	assert.match(err, /tasks\[1\] is missing label\. To fix it, add a label, a 3 to 7 word title for the run\.$/);
});

test("start rejects a top-level label beside tasks", () => {
	assert.match(error({ action: "start", label: "L", tasks: [{ label: "A", agent: "a", task: "x" }] }), /label goes inside each tasks entry/);
});

test("labels are trimmed and capped at 80 characters", () => {
	const result = ok({ action: "start", label: `  ${"w".repeat(100)}  `, agent: "a", task: "x" });
	assert.equal((result as { tasks: { label: string }[] }).tasks[0].label, "w".repeat(80));
});

test("start rejects bad enum values", () => {
	assert.match(error({ action: "start", label: "L", agent: "a", task: "x", notify: "loud" }), /notify must be/);
	assert.match(error({ action: "start", label: "L", agent: "a", task: "x", agentScope: "all" }), /agentScope must be/);
});

test("start rejects fields of other actions and points at the action that takes them", () => {
	const err = error({ action: "start", label: "L", agent: "a", task: "x", id: "sub-1" });
	assert.match(err, /id is not accepted/);
	assert.match(err, /did you mean action "resume" with id\?/);
});

test("status takes nothing else", () => {
	assert.deepEqual(ok({ action: "status" }), { action: "status" });
	const err = error({ action: "status", id: "sub-1" });
	assert.match(err, /^action "status" takes no other fields\. id is not accepted\./);
});

test("status lists start-only options as not accepted", () => {
	assert.match(error({ action: "status", background: true }), /background is not accepted\. Did you mean action "start"\?/);
});

test("wait takes ids and a timeout in seconds, both optional", () => {
	assert.deepEqual(ok({ action: "wait" }), { action: "wait" });
	assert.deepEqual(ok({ action: "wait", ids: ["sub-1", "sub-2"], timeout_s: 30 }), {
		action: "wait",
		ids: ["sub-1", "sub-2"],
		timeoutMs: 30_000,
	});
});

test("wait rejects an empty ids list, a bad timeout, and a lone id", () => {
	assert.match(error({ action: "wait", ids: [] }), /ids must be a non-empty list/);
	assert.match(error({ action: "wait", timeout_s: 0 }), /timeout_s must be a positive number/);
	const err = error({ action: "wait", id: "sub-1" });
	assert.match(err, /^action "wait" takes ids and timeout_s, both optional\. id is not accepted\./);
});

test("send takes id and message with steer as the default mode", () => {
	assert.deepEqual(ok({ action: "send", id: "sub-1", message: "hi" }), {
		action: "send",
		id: "sub-1",
		message: "hi",
		mode: "steer",
	});
	assert.equal((ok({ action: "send", id: "sub-1", message: "hi", mode: "follow_up" }) as { mode: string }).mode, "follow_up");
});

test("send names each missing field", () => {
	assert.match(error({ action: "send", id: "sub-1" }), /^action "send" takes id and message \(mode optional\)\. Missing message\.$/);
	assert.match(error({ action: "send", message: "hi" }), /Missing id\.$/);
	assert.match(error({ action: "send" }), /Missing id and message\.$/);
});

test("send with a task points at resume", () => {
	assert.equal(
		error({ action: "send", id: "sub-1", task: "more work" }),
		'action "send" takes id and message (mode optional). task is not accepted. Did you mean action "resume"?',
	);
	assert.equal(
		error({ action: "send", id: "sub-1", message: "hi", task: "more work" }),
		'action "send" takes id and message (mode optional). task is not accepted. Drop task, or did you mean action "resume" with task?',
	);
});

test("stop takes an id and nothing else", () => {
	assert.deepEqual(ok({ action: "stop", id: "sub-1" }), { action: "stop", id: "sub-1" });
	assert.match(error({ action: "stop" }), /^action "stop" takes id\. Missing id\.$/);
	assert.match(error({ action: "stop", ids: ["sub-1"] }), /ids is not accepted\. Did you mean action "wait"\?/);
});

test("resume takes an id with answers or with a task", () => {
	assert.deepEqual(ok({ action: "resume", id: "sub-1", answers: { scope: "All" } }), {
		action: "resume",
		id: "sub-1",
		answers: { scope: "All" },
	});
	assert.deepEqual(ok({ action: "resume", id: "sub-1", task: "next" }), { action: "resume", id: "sub-1", task: "next" });
});

test("resume accepts a label with a task and trims it", () => {
	assert.deepEqual(ok({ action: "resume", id: "sub-1", task: "next", label: "  Second pass  " }), {
		action: "resume",
		id: "sub-1",
		task: "next",
		label: "Second pass",
	});
	assert.match(error({ action: "resume", id: "sub-1", task: "next", label: " " }), /label is empty/);
});

test("resume with answers rejects a label", () => {
	assert.match(error({ action: "resume", id: "sub-1", answers: { a: "b" }, label: "L" }), /label is accepted only with task/);
});

test("send with a label is rejected", () => {
	const err = error({ action: "send", id: "sub-1", message: "hi", label: "L" });
	assert.match(err, /label is not accepted/);
});

test("resume needs an id and exactly one of answers or task", () => {
	assert.match(error({ action: "resume", task: "next" }), /Missing id\.$/);
	assert.match(error({ action: "resume", id: "sub-1" }), /Missing answers or task/);
	assert.match(error({ action: "resume", id: "sub-1", answers: { a: "b" }, task: "x" }), /both answers and task/);
	assert.match(error({ action: "resume", id: "sub-1", answers: {} }), /at least one question id/);
});

test("resume with a message points at send", () => {
	const err = error({ action: "resume", id: "sub-1", message: "hi" });
	assert.match(err, /^action "resume" takes id and exactly one of answers or task \(label optional with task, background optional\)\. message is not accepted\./);
	assert.match(err, /Did you mean action "send"\?/);
});

test("several stray fields are listed together", () => {
	assert.match(error({ action: "stop", id: "sub-1", message: "a", mode: "steer" }), /message and mode are not accepted/);
});

test("an unknown or missing action lists the actions", () => {
	const expected = 'action must be one of "start", "status", "wait", "send", "stop", "resume".';
	assert.equal(error({ action: "run" }), expected);
	assert.equal(error({ agent: "a", task: "x" }), expected);
});

test("undefined fields count as absent", () => {
	assert.deepEqual(ok({ action: "stop", id: "sub-1", task: undefined }), { action: "stop", id: "sub-1" });
});

test("resume accepts a boolean background with answers or a task", () => {
	assert.deepEqual(ok({ action: "resume", id: "sub-1", task: "next", background: true }), {
		action: "resume",
		id: "sub-1",
		task: "next",
		background: true,
	});
	assert.deepEqual(ok({ action: "resume", id: "sub-1", answers: { a: "b" }, background: false }), {
		action: "resume",
		id: "sub-1",
		answers: { a: "b" },
		background: false,
	});
});

test("resume rejects a background that is not a boolean", () => {
	for (const background of ["true", 1, null]) {
		assert.match(error({ action: "resume", id: "sub-1", task: "next", background }), /background must be true or false/);
	}
});
