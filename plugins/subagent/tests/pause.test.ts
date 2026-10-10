import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { PAUSE_NOTICE } from "../../ask/extensions/pause.ts";
import { formatPaused } from "../extensions/format.ts";
import { detectPause, getFinalOutput } from "../extensions/pause.ts";

const assistant = (parts: Message["content"] extends infer _ ? unknown[] : never) =>
	({ role: "assistant", content: parts, stopReason: "toolUse" }) as unknown as Message;
const toolResult = (toolName: string, toolCallId: string, text: string) =>
	({ role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }] }) as unknown as Message;
const user = (text: string) => ({ role: "user", content: text }) as unknown as Message;

const askCall = {
	type: "toolCall",
	id: "call-1",
	name: "ask",
	arguments: { questions: [{ id: "access", question: "Which access block?", options: [{ label: "Open" }, { label: "Restrict", recommended: "safer" }] }] },
};

test("detectPause returns the normalized questions of a run that ended on a blocked ask", () => {
	const messages = [
		user("Task: define the agent"),
		assistant([{ type: "text", text: "Reading the repo." }, { type: "toolCall", id: "call-0", name: "read", arguments: { path: "x" } }]),
		toolResult("read", "call-0", "contents"),
		assistant([askCall]),
		toolResult("ask", "call-1", PAUSE_NOTICE),
	];
	const questions = detectPause(messages);
	assert.ok(questions);
	assert.equal(questions.length, 1);
	assert.equal(questions[0].id, "access");
	assert.equal(questions[0].label, "Access");
	assert.equal(questions[0].options?.[0].label, "Restrict");
});

test("detectPause ignores an ask that was answered and runs that never asked", () => {
	assert.equal(detectPause([assistant([askCall]), toolResult("ask", "call-1", "access: Restrict")]), undefined);
	assert.equal(detectPause([user("hi"), assistant([{ type: "text", text: "done" }])]), undefined);
});

test("detectPause yields an empty list when the paused call's arguments cannot be found", () => {
	assert.deepEqual(detectPause([toolResult("ask", "missing", PAUSE_NOTICE)]), []);
});

test("getFinalOutput returns the last assistant text", () => {
	const messages = [assistant([{ type: "text", text: "first" }]), toolResult("read", "c", "x"), assistant([{ type: "text", text: "last" }])];
	assert.equal(getFinalOutput(messages), "last");
	assert.equal(getFinalOutput([]), "");
});

test("formatPaused renders status, resume id, last output, questions, and the resume instruction", () => {
	const text = formatPaused({
		agent: "opus-4-8",
		sessionId: "sub-abc12345",
		questions: detectPause([assistant([askCall]), toolResult("ask", "call-1", PAUSE_NOTICE)]) ?? [],
		lastOutput: "Found the server.\nTwo options.",
	});
	const lines = text.split("\n");
	assert.deepEqual(lines.slice(0, 3), ["status: paused", "resume_id: sub-abc12345", "agent: opus-4-8"]);
	assert.equal(lines[3], "last_output: Found the server.");
	assert.equal(lines[4], "  Two options.");
	assert.equal(lines[5], "questions:");
	assert.ok(text.includes('Answer with subagent({ action: "resume", id: "sub-abc12345", answers: { "access": "<option label or free text>" } }).'));
	assert.ok(text.endsWith("Do not guess on the subagent's behalf."));
});
