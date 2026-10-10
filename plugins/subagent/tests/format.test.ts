import assert from "node:assert/strict";
import * as os from "node:os";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { PAUSE_NOTICE } from "../../ask/extensions/pause.ts";
import {
	formatAge,
	formatCallLine,
	formatCompleted,
	formatDetached,
	formatFailed,
	formatOverlayRow,
	formatDeliverySection,
	formatPausedResult,
	layoutOverlay,
	type OverlayEntry,
	overlayStateColor,
	formatProgressLine,
	formatRunResult,
	formatSessionFooter,
	formatStarted,
	formatStatus,
	formatStatusLine,
	formatToolCall,
	formatUsageStats,
	formatWaitSection,
	formatWaitSections,
	PER_TASK_OUTPUT_CAP,
	snapshotRun,
	truncateOutput,
	windowEntries,
} from "../extensions/format.ts";
import { detectPause } from "../extensions/pause.ts";
import type { Run, SingleResult } from "../extensions/types.ts";

const assistant = (parts: unknown[]) => ({ role: "assistant", content: parts, stopReason: "stop" }) as unknown as Message;
const toolResult = (toolName: string, toolCallId: string, text: string) =>
	({ role: "toolResult", toolName, toolCallId, content: [{ type: "text", text }] }) as unknown as Message;
const text = (value: string) => ({ type: "text", text: value });

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const result = (overrides: Partial<SingleResult> = {}): SingleResult => ({
	agent: "glm",
	agentSource: "user",
	task: "say pong",
	exitCode: 0,
	messages: [assistant([text("pong")])],
	stderr: "",
	usage,
	sessionId: "sub-abc12345",
	...overrides,
});

test("formatCompleted ends the final text with the session footer and the resume call shape", () => {
	const out = formatCompleted(result());
	assert.equal(
		out,
		[
			"pong",
			"",
			"---",
			"session_id: sub-abc12345 (agent: glm)",
			'Follow up in this context: subagent({ action: "resume", id: "sub-abc12345", task: "..." })',
		].join("\n"),
	);
	assert.equal(out.endsWith(formatSessionFooter(result())), true);
});

test("formatCompleted says so when the run produced no text", () => {
	assert.ok(formatCompleted(result({ messages: [] })).startsWith("(no output)\n\n---"));
});

test("formatPausedResult carries the paused status, session id, and the answers call shape", () => {
	const ask = {
		type: "toolCall",
		id: "c1",
		name: "ask",
		arguments: { questions: [{ id: "scope", question: "Which scope?", options: [{ label: "All" }] }] },
	};
	const messages = [assistant([ask]), toolResult("ask", "c1", PAUSE_NOTICE)];
	const out = formatPausedResult(result({ messages, paused: detectPause(messages) }));
	assert.ok(out.startsWith("status: paused\nresume_id: sub-abc12345\nagent: glm"));
	assert.ok(out.includes('subagent({ action: "resume", id: "sub-abc12345", answers: { "scope": "<option label or free text>" } })'));
	assert.ok(!out.includes("session_id:"));
});

test("formatFailed leads with the stop reason and prefers the error message over stderr", () => {
	const failed = result({ exitCode: 1, stopReason: "error", errorMessage: "rate limited", stderr: "noise" });
	assert.equal(formatFailed(failed), "Agent error: rate limited");
	assert.equal(formatFailed(result({ exitCode: 1, stderr: "boom", messages: [] })), "Agent failed: boom");
	assert.equal(formatFailed(result({ exitCode: 1, messages: [] })), "Agent failed: (no output)");
});

test("formatUsageStats lists turns, tokens, cost, context, and model, skipping zeros", () => {
	assert.equal(formatUsageStats(usage), "");
	assert.equal(
		formatUsageStats(
			{ input: 1234, output: 56, cacheRead: 20000, cacheWrite: 1500000, cost: 0.0123, contextTokens: 9500, turns: 2 },
			"glm",
		),
		"2 turns ↑1.2k ↓56 R20k W1.5M $0.0123 ctx:9.5k glm",
	);
	assert.equal(formatUsageStats({ ...usage, turns: 1 }), "1 turn");
});

const fg = (color: string, value: string) => `<${color}>${value}</${color}>`;

test("formatToolCall previews known tools and truncates long commands", () => {
	assert.equal(formatToolCall("bash", { command: "ls" }, fg), "<muted>$ </muted><toolOutput>ls</toolOutput>");
	const long = formatToolCall("bash", { command: "x".repeat(80) }, fg);
	assert.ok(long.includes(`${"x".repeat(60)}...`));
	assert.equal(
		formatToolCall("read", { path: "a.ts", offset: 5, limit: 3 }, fg),
		"<muted>read </muted><accent>a.ts</accent><warning>:5-7</warning>",
	);
	assert.equal(
		formatToolCall("write", { path: "a.ts", content: "a\nb\nc" }, fg),
		"<muted>write </muted><accent>a.ts</accent><dim> (3 lines)</dim>",
	);
	assert.equal(
		formatToolCall("grep", { pattern: "foo" }, fg),
		"<muted>grep </muted><accent>/foo/</accent><dim> in .</dim>",
	);
});

test("formatToolCall shortens the home directory and previews unknown tools as JSON", () => {
	assert.equal(
		formatToolCall("edit", { path: `${os.homedir()}/x.ts` }, fg),
		"<muted>edit </muted><accent>~/x.ts</accent>",
	);
	assert.equal(formatToolCall("custom", { a: 1 }, fg), '<accent>custom</accent><dim> {"a":1}</dim>');
});

test("truncateOutput leaves small output alone and caps large output by bytes", () => {
	assert.equal(truncateOutput("short"), "short");
	const out = truncateOutput("é".repeat(PER_TASK_OUTPUT_CAP));
	const kept = out.split("\n\n[Output truncated")[0];
	assert.ok(Buffer.byteLength(kept, "utf8") <= PER_TASK_OUTPUT_CAP);
	assert.ok(out.includes("bytes omitted"));
});

const run = (overrides: Partial<Run> = {}): Run => ({
	id: "sub-abc12345",
	label: "Say pong",
	agent: "glm",
	agentSource: "user",
	task: "say pong",
	state: "done",
	background: false,
	notify: "wake",
	delivered: false,
	messages: [assistant([text("earlier")]), assistant([text("pong")])],
	turnStart: 1,
	usage: { ...usage, turns: 3, input: 12000, output: 2100 },
	lastActivity: 1_000_000,
	startedAt: 900_000,
	stderr: "",
	waiters: 0,
	...overrides,
});

const NOW = 1_000_000;
/** A running run with the usage the overlay row tests print. */
const liveRun = (overrides: Partial<Run> = {}): Run =>
	run({
		id: "sub-bddd",
		state: "running",
		usage: { ...usage, turns: 11, input: 20, output: 19_000 },
		lastActivity: NOW - 30_000,
		...overrides,
	});

test("formatStarted prints the status and one session line per run", () => {
	assert.equal(formatStarted([{ sessionId: "sub-1", agent: "glm" }]), "status: started\nsession_id: sub-1 (agent: glm)");
	assert.equal(
		formatStarted([
			{ sessionId: "sub-1", agent: "glm" },
			{ sessionId: "sub-2", agent: "scout" },
		]),
		"status: started\nsession_id: sub-1 (agent: glm)\nsession_id: sub-2 (agent: scout)",
	);
});

test("formatDetached lists the runs and the wait call that collects them", () => {
	assert.equal(
		formatDetached([
			{ sessionId: "sub-1", agent: "glm" },
			{ sessionId: "sub-2", agent: "scout" },
		]),
		[
			"status: detached",
			"session_id: sub-1 (agent: glm)",
			"session_id: sub-2 (agent: scout)",
			'The run keeps working in the background. Collect it with subagent({ action: "wait", ids: ["sub-1", "sub-2"] }).',
		].join("\n"),
	);
});

test("formatDetached appends the user-message note for the user-input reason only", () => {
	const runs = [{ sessionId: "sub-1", agent: "glm" }];
	const note =
		"The user sent a message while you were waiting. Answer it. Results will be posted when the runs finish, do not wait again unless asked.";
	assert.ok(formatDetached(runs, "user-input").endsWith(`\n${note}`));
	assert.equal(formatDetached(runs, "abort"), formatDetached(runs));
	assert.ok(!formatDetached(runs, "abort").includes(note));
});

test("snapshotRun keeps the current turn only and marks a failed run with a non-zero exit", () => {
	const snap = snapshotRun(run(), true);
	assert.equal(snap.sessionId, "sub-abc12345");
	assert.equal(snap.messages.length, 1);
	assert.equal(snap.exitCode, 0);
	assert.equal(snapshotRun(run(), false).messages.length, 0);
	const failed = snapshotRun(run({ state: "failed", errorMessage: "boom" }), true);
	assert.equal(failed.exitCode, 1);
	assert.equal(formatRunResult(failed), "Agent failed: boom");
});

test("formatRunResult picks the shape for each state", () => {
	assert.ok(formatRunResult(snapshotRun(run(), true)).startsWith("pong\n\n---\nsession_id: sub-abc12345"));
	assert.ok(formatRunResult(snapshotRun(run({ state: "paused", paused: [] }), true)).startsWith("status: paused"));
	assert.equal(
		formatRunResult(snapshotRun(run({ state: "running" }), true)),
		"status: running\nsession_id: sub-abc12345 (agent: glm)",
	);
	assert.equal(formatRunResult(snapshotRun(run({ state: "stopped" }), true)).split("\n")[0], "status: stopped");
});

test("formatWaitSection heads the result with id, agent, and state", () => {
	const section = formatWaitSection(snapshotRun(run(), true));
	assert.ok(section.startsWith("### sub-abc12345 [glm] done · Say pong\n\npong\n\n---"));
});

test("formatWaitSections separates sections and reports an empty wait", () => {
	const both = formatWaitSections([snapshotRun(run(), true), snapshotRun(run({ id: "sub-2", state: "running" }), true)]);
	assert.match(both, /\n\n---\n\n### sub-2 \[glm\] running · Say pong\n\nstatus: running/);
	assert.equal(formatWaitSections([]), "No live subagent runs to wait on.");
});

test("formatStatusLine shows id, agent, state, turns, tokens, age, and the label", () => {
	assert.equal(formatStatusLine(run(), 1_014_000), 'sub-abc12345 [glm] done · 3 turns ↑12k ↓2.1k · 14s ago · Say pong');
	assert.ok(!formatStatusLine(run(), 1_014_000).includes("say pong"));
});

test("formatStatus lists one line per run or says there are none", () => {
	assert.equal(formatStatus([], 0), "No subagent runs in this session.");
	assert.equal(formatStatus([run(), run({ id: "sub-2" })], 1_000_000).split("\n").length, 2);
});

test("formatAge abbreviates seconds, minutes, hours, and days", () => {
	assert.equal(formatAge(14_000), "14s");
	assert.equal(formatAge(3 * 60_000 + 5_000), "3m");
	assert.equal(formatAge(2 * 3_600_000), "2h");
	assert.equal(formatAge(3 * 86_400_000), "3d");
	assert.equal(formatAge(-5), "0s");
});

test("formatCallLine names the action, agent, and label for a start", () => {
	assert.equal(
		formatCallLine({ action: "start", label: "Pong check", agent: "glm", task: "say pong" }),
		"subagent start glm · Pong check",
	);
	assert.equal(formatCallLine({ action: "start", agent: "glm" }), "subagent start glm");
});

test("formatCallLine collapses several tasks to the first plus a count and expands to one line each", () => {
	const args = {
		action: "start",
		tasks: [
			{ agent: "glm", label: "One", task: "a" },
			{ agent: "opus", label: "Two", task: "b" },
			{ agent: "glm", label: "Three", task: "c" },
		],
	};
	assert.equal(formatCallLine(args), "subagent start glm · One +2 more");
	assert.equal(formatCallLine(args, { expanded: true }), "subagent start glm · One\n  opus · Two\n  glm · Three");
	assert.equal(formatCallLine({ action: "start", tasks: [{ agent: "glm", label: "One", task: "a" }] }), "subagent start glm · One");
});

test("formatCallLine covers wait, send, stop, resume, and status", () => {
	assert.equal(formatCallLine({ action: "wait", ids: ["sub-1", "sub-2"] }), "subagent wait sub-1, sub-2");
	assert.equal(formatCallLine({ action: "wait" }), "subagent wait all");
	assert.equal(formatCallLine({ action: "send", id: "sub-1", mode: "follow_up" }), "subagent send sub-1 · follow_up");
	assert.equal(formatCallLine({ action: "send", id: "sub-1" }), "subagent send sub-1 · steer");
	assert.equal(formatCallLine({ action: "stop", id: "sub-1" }), "subagent stop sub-1");
	assert.equal(formatCallLine({ action: "resume", id: "sub-1", answers: { a: "x", b: "y" } }), "subagent resume sub-1 · answers (2)");
	assert.equal(formatCallLine({ action: "resume", id: "sub-1", task: "keep going" }), "subagent resume sub-1 · keep going");
	assert.equal(formatCallLine({ action: "resume", id: "sub-1", task: "keep going", label: "Second pass" }), "subagent resume sub-1 · Second pass");
	assert.equal(formatCallLine({ action: "status" }), "subagent status");
});

test("formatProgressLine shows turns, tokens, and the last tool call", () => {
	const usage = { input: 20, output: 19_000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 11 };
	assert.equal(
		formatProgressLine({ usage, lastTool: { name: "edit", args: { path: "src/a.ts" } } }),
		"11 turns ↑20 ↓19k · → edit src/a.ts",
	);
	assert.equal(formatProgressLine({ usage: { ...usage, turns: 1 } }), "1 turn ↑20 ↓19k");
});

test("snapshotRun carries the last tool call", () => {
	const lastTool = { name: "read", args: { path: "a" } };
	assert.deepEqual(snapshotRun(run({ lastTool }), false).lastTool, lastTool);
});

test("formatOverlayRow lays out a running row to the requested width with the age at the right edge", () => {
	const row = formatOverlayRow(liveRun({ lastTool: { name: "edit", args: { path: "src/a.ts" } } }), NOW, 70);
	assert.equal(row.length, 70);
	assert.match(row, /^▶ glm sub-bddd {2}Say pong {2}11 turns ↑20 ↓19k {2}→ edit src\/a\.ts +30s ago$/);
});

test("formatOverlayRow shows paused questions and the state of finished rows", () => {
	const paused = liveRun({ state: "paused", paused: [{ id: "a", question: "?", options: [] }, { id: "b", question: "?", options: [] }] });
	assert.match(formatOverlayRow(paused, NOW, 60), /^⏸ glm sub-bddd {2}Say pong {2}paused: 2 questions +30s ago$/);
	assert.match(formatOverlayRow(liveRun({ state: "done" }), NOW, 60), /^✓ glm sub-bddd {2}Say pong {2}done +30s ago$/);
	assert.match(formatOverlayRow(liveRun({ state: "failed" }), NOW, 60), /^✗ glm sub-bddd {2}Say pong {2}failed +30s ago$/);
});

test("formatOverlayRow truncates the detail so the age stays visible", () => {
	const row = formatOverlayRow(liveRun({ lastTool: { name: "bash", args: { command: "x".repeat(200) } } }), NOW, 40);
	assert.equal(row.length, 40);
	assert.ok(row.endsWith("30s ago"));
	assert.ok(row.includes("…"));
});

test("formatDeliverySection heads the result with the label", () => {
	const section = formatDeliverySection(snapshotRun(run({ label: "Audit the store" }), true));
	assert.ok(section.startsWith("### sub-abc12345 [glm] done · Audit the store\n\npong"));
});

test("snapshotRun carries the label", () => {
	assert.equal(snapshotRun(run({ label: "Audit the store" }), false).label, "Audit the store");
});

const layoutRun = (id: string, state: Run["state"], startedAt: number): Run => ({ id, state, startedAt }) as Run;

const describeLayout = (runs: Run[]): string[] =>
	layoutOverlay(runs).map((entry) => (entry.kind === "run" ? entry.run.id : entry.kind === "header" ? `# ${entry.title}` : entry.kind));

test("layoutOverlay groups running above finished, each newest first, with headers and a gap between", () => {
	const runs = [
		layoutRun("d1", "done", 5),
		layoutRun("q1", "queued", 1),
		layoutRun("f1", "failed", 9),
		layoutRun("r1", "running", 3),
		layoutRun("p1", "paused", 2),
		layoutRun("s1", "stopped", 7),
	];
	assert.deepEqual(describeLayout(runs), ["# RUNNING", "r1", "p1", "q1", "gap", "# FINISHED", "f1", "s1", "d1"]);
});

test("layoutOverlay marks an empty FINISHED group with none", () => {
	assert.deepEqual(describeLayout([layoutRun("a", "running", 1), layoutRun("b", "paused", 2)]), ["# RUNNING", "b", "a", "gap", "# FINISHED", "none"]);
});

test("layoutOverlay marks an empty RUNNING group with none", () => {
	assert.deepEqual(describeLayout([layoutRun("a", "done", 1), layoutRun("b", "stopped", 2)]), ["# RUNNING", "none", "gap", "# FINISHED", "b", "a"]);
});

test("layoutOverlay marks both groups with none for no runs", () => {
	assert.deepEqual(describeLayout([]), ["# RUNNING", "none", "gap", "# FINISHED", "none"]);
});

test("overlayStateColor maps every state to a theme color", () => {
	assert.equal(overlayStateColor("queued"), "accent");
	assert.equal(overlayStateColor("running"), "accent");
	assert.equal(overlayStateColor("paused"), "warning");
	assert.equal(overlayStateColor("done"), "success");
	assert.equal(overlayStateColor("failed"), "error");
	assert.equal(overlayStateColor("stopped"), "muted");
});

const bracket = (_state: Run["state"], text: string): string => `<${text}>`;

test("formatOverlayRow paints the icon and state word and keeps the width", () => {
	const plain = formatOverlayRow(liveRun({ state: "failed" }), NOW, 60);
	const painted = formatOverlayRow(liveRun({ state: "failed" }), NOW, 60, bracket);
	assert.equal(painted, "<✗> glm sub-bddd  Say pong  <failed>" + plain.slice(plain.indexOf("failed") + 6));
	assert.equal(painted.replace(/[<>]/g, "").length, 60);
	const paused = liveRun({ state: "paused", paused: [{ id: "a", question: "?", options: [] }] });
	assert.match(formatOverlayRow(paused, NOW, 60, bracket), /^<⏸> glm sub-bddd {2}Say pong {2}<paused>: 1 question +30s ago$/);
});

test("formatOverlayRow paints only the icon of a running row", () => {
	const row = formatOverlayRow(liveRun({}), NOW, 60, bracket);
	assert.match(row, /^<▶> glm sub-bddd {2}Say pong {2}11 turns ↑20 ↓19k +30s ago$/);
	assert.equal(row.replace(/[<>]/g, "").length, 60);
});

test("formatOverlayRow keeps the width when painting a truncated row", () => {
	const row = formatOverlayRow(liveRun({ state: "paused" }), NOW, 24, bracket);
	assert.equal(row.replace(/[<>]/g, "").length, 24);
});

const windowList = (count: number): OverlayEntry[] => Array.from({ length: count }, () => ({ kind: "gap" }));

test("windowEntries returns every entry without markers when the list fits", () => {
	const entries = windowList(5);
	assert.deepEqual(windowEntries(entries, 2, 5, 0), { start: 0, entries, above: 0, below: 0 });
});

test("windowEntries with the selection at the top hides only entries below", () => {
	const view = windowEntries(windowList(20), 0, 8, 0);
	assert.equal(view.entries.length, 7);
	assert.deepEqual([view.start, view.above, view.below], [0, 0, 13]);
});

test("windowEntries with the selection in the middle hides entries on both sides", () => {
	const view = windowEntries(windowList(20), 10, 8, 0);
	assert.equal(view.entries.length, 6);
	assert.equal(view.above + view.entries.length + view.below, 20);
	assert.ok(view.above > 0 && view.below > 0);
	assert.ok(10 >= view.start && 10 < view.start + view.entries.length);
});

test("windowEntries with the selection at the bottom hides only entries above", () => {
	const view = windowEntries(windowList(20), 19, 8, 0);
	assert.equal(view.entries.length, 7);
	assert.deepEqual([view.start, view.above, view.below], [13, 13, 0]);
});

test("windowEntries keeps the window still while the selection moves inside it", () => {
	const entries = windowList(20);
	let view = windowEntries(entries, 10, 8, 0);
	const { start } = view;
	for (const selected of [start + 1, start + 2, start + 1]) {
		view = windowEntries(entries, selected, 8, view.start);
		assert.equal(view.start, start);
	}
	view = windowEntries(entries, start - 1, 8, view.start);
	assert.equal(view.start, start - 1);
});

test("windowEntries pulls the window back when the list shrinks", () => {
	const view = windowEntries(windowList(10), 9, 8, 15);
	assert.equal(view.below, 0);
	assert.equal(view.entries.length + view.above, 10);
});
