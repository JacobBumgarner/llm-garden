/**
 * Text formatting for subagent results: completed, paused, and failed shapes,
 * the session footer, the started and detached notices, wait and posted result
 * sections, status lines, call and progress lines, the overlay layout with its
 * rows, group headers, scroll windowing, and state colors, usage lines, tool
 * call previews, run snapshots, and output truncation. Imports only types from
 * pi packages.
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { formatQuestionsForOrchestrator } from "../../ask/extensions/pause.ts";
import type { DetachReason } from "./blocked.ts";
import { getFinalOutput } from "./pause.ts";
import type { DisplayItem, PausedRun, Run, RunSnapshot, SingleResult, UsageStats } from "./types.ts";

export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Abbreviate a token count: 999, 1.2k, 45k, 1.3M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Join usage numbers and the model into one dim status line. */
export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/** Render one tool call as a themed one-line preview. */
export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Report whether the child exited non-zero or stopped on an error or abort. */
export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/** Report whether the run ended on a blocked `ask` without failing. */
export function isPausedResult(result: SingleResult): boolean {
	return result.paused !== undefined && !isFailedResult(result);
}

/** Render the block an orchestrator reads when a run pauses, ending in the call that resumes it. */
export function formatPaused(run: PausedRun): string {
	const lines = ["status: paused", `resume_id: ${run.sessionId}`, `agent: ${run.agent}`];
	const progress = run.lastOutput.trim();
	if (progress) lines.push(`last_output: ${progress.split("\n").join("\n  ")}`);
	lines.push(formatQuestionsForOrchestrator(run.questions));
	const example = run.questions.length > 0 ? `"${run.questions[0].id}": "<option label or free text>"` : "";
	lines.push(
		"",
		`Answer with subagent({ action: "resume", id: "${run.sessionId}", answers: { ${example} } }).`,
		"If you lack the context to answer, use `ask` yourself before resuming. Do not guess on the subagent's behalf.",
	);
	return lines.join("\n");
}

/** Render the paused block for a result. */
export function formatPausedResult(result: SingleResult): string {
	return formatPaused({
		agent: result.agent,
		sessionId: result.sessionId,
		questions: result.paused ?? [],
		lastOutput: getFinalOutput(result.messages),
	});
}

/** Render the footer that tells the orchestrator how to continue a completed run's session. */
export function formatSessionFooter(result: SingleResult): string {
	return [
		"---",
		`session_id: ${result.sessionId} (agent: ${result.agent})`,
		`Follow up in this context: subagent({ action: "resume", id: "${result.sessionId}", task: "..." })`,
	].join("\n");
}

/** Render a completed run's final text followed by the session footer. */
export function formatCompleted(result: SingleResult): string {
	return `${getFinalOutput(result.messages) || "(no output)"}\n\n${formatSessionFooter(result)}`;
}

/** Render a failed result's error text, led by its stop reason. */
export function formatFailed(result: SingleResult): string {
	const detail = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	return `Agent ${result.stopReason || "failed"}: ${detail}`;
}

/** Cut output to `PER_TASK_OUTPUT_CAP` bytes and say how much was omitted and where the rest is. */
export function truncateOutput(output: string, whereFull = "Full output preserved in tool details."): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. ${whereFull}]`;
}

/**
 * Snapshot a run for tool result details. With `withMessages` the snapshot
 * carries the current turn's messages, else none. A failed run gets a non-zero
 * exit code so the result helpers treat it as failed.
 */
export function snapshotRun(run: Run, withMessages: boolean): RunSnapshot {
	return {
		sessionId: run.id,
		label: run.label,
		agent: run.agent,
		agentSource: run.agentSource,
		task: run.task,
		state: run.state,
		background: run.background,
		exitCode: run.state === "failed" ? run.exitCode || 1 : 0,
		messages: withMessages ? run.messages.slice(run.turnStart) : [],
		stderr: run.state === "failed" ? run.stderr : "",
		usage: { ...run.usage },
		model: run.model,
		stopReason: run.stopReason,
		errorMessage: run.errorMessage,
		paused: run.state === "paused" ? (run.paused ?? []) : undefined,
		lastTool: run.lastTool,
	};
}

/** Render a snapshot in the shape its state calls for: completed, paused, failed, stopped, or still in flight. */
export function formatRunResult(run: RunSnapshot): string {
	switch (run.state) {
		case "done":
			return formatCompleted(run);
		case "paused":
			return formatPausedResult(run);
		case "failed":
			return formatFailed(run);
		default:
			return `status: ${run.state}\nsession_id: ${run.sessionId} (agent: ${run.agent})`;
	}
}

/** Render the header of a result section: id, agent, state, and label. */
function sectionHeader(run: RunSnapshot): string {
	return `### ${run.sessionId} [${run.agent}] ${run.state} · ${run.label}`;
}

/** Render one wait section: a `### <id> [<agent>] <state> · <label>` header over the capped result. */
export function formatWaitSection(run: RunSnapshot): string {
	return `${sectionHeader(run)}\n\n${truncateOutput(formatRunResult(run))}`;
}

/** Render one posted result section: the wait section header over a capped result that names the session holding the full transcript. */
export function formatDeliverySection(run: RunSnapshot): string {
	const whereFull = `The full transcript is in subagent session ${run.sessionId}.`;
	return `${sectionHeader(run)}\n\n${truncateOutput(formatRunResult(run), whereFull)}`;
}

/** Render one section per run, or a notice when there is nothing to report. */
export function formatWaitSections(runs: RunSnapshot[]): string {
	if (runs.length === 0) return "No live subagent runs to wait on.";
	return runs.map(formatWaitSection).join("\n\n---\n\n");
}

/** Render the notice for runs that keep working after the tool call returns. */
export function formatStarted(runs: { sessionId: string; agent: string }[]): string {
	return ["status: started", ...runs.map((r) => `session_id: ${r.sessionId} (agent: ${r.agent})`)].join("\n");
}

const USER_INPUT_NOTE =
	"The user sent a message while you were waiting. Answer it. Results will be posted when the runs finish, do not wait again unless asked.";

/**
 * Render the notice for runs whose wait was released, ending in the call that
 * collects them. A "user-input" reason adds the instruction to answer the user.
 */
export function formatDetached(runs: { sessionId: string; agent: string }[], reason: DetachReason = "abort"): string {
	const ids = runs.map((r) => `"${r.sessionId}"`).join(", ");
	return [
		"status: detached",
		...runs.map((r) => `session_id: ${r.sessionId} (agent: ${r.agent})`),
		`The run keeps working in the background. Collect it with subagent({ action: "wait", ids: [${ids}] }).`,
		...(reason === "user-input" ? [USER_INPUT_NOTE] : []),
	].join("\n");
}

/** Abbreviate a duration: 14s, 3m, 2h, 1d. */
export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

/** Cut text to `max` code points, ending in an ellipsis when cut. */
function cutText(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

/** Flatten whitespace to single spaces and cut the text to `max` characters on one line. */
export function previewText(text: string, max: number): string {
	return cutText(text.replace(/\s+/g, " ").trim(), max);
}

/** Return the label, or a 60-character preview of the task when there is none. */
export function labelOrPreview(label: string | undefined, task: string): string {
	return label || previewText(task, 60);
}

/** Render turns and in/out tokens: `3 turns ↑12k ↓2.1k`. */
function formatTurnsAndTokens(usage: Pick<UsageStats, "turns" | "input" | "output">): string {
	const { turns, input, output } = usage;
	return `${turns} turn${turns === 1 ? "" : "s"} ↑${formatTokens(input)} ↓${formatTokens(output)}`;
}

/** Render one status line: id, agent, state, turns, tokens, age of last activity, and label. */
export function formatStatusLine(run: Run, now: number): string {
	return [
		`${run.id} [${run.agent}] ${run.state}`,
		formatTurnsAndTokens(run.usage),
		`${formatAge(now - run.lastActivity)} ago`,
		run.label,
	].join(" · ");
}

/** Build the one-line description of a run's last tool call, as plain text. */
function lastToolText(tool: { name: string; args: Record<string, unknown> }): string {
	return formatToolCall(tool.name, tool.args, (_color, text) => text);
}

/** Render the progress line of an in-flight run: turns, tokens, and its last tool call. */
export function formatProgressLine(run: Pick<RunSnapshot, "usage" | "lastTool">): string {
	const usage = formatTurnsAndTokens(run.usage);
	return run.lastTool ? `${usage} · → ${lastToolText(run.lastTool)}` : usage;
}

const OVERLAY_ICONS: Record<Run["state"], string> = {
	queued: "◌", // not ⏳, which is double width and breaks the row alignment
	running: "▶",
	paused: "⏸",
	done: "✓",
	failed: "✗",
	stopped: "■",
};

/** Return the state word that opens an overlay row's detail: the state name, or nothing for a running run. */
function stateWord(run: Run): string {
	return run.state === "running" ? "" : run.state;
}

/** Render the state-dependent middle of an overlay row, opening with its state word. */
function overlayDetail(run: Run): string {
	if (run.state === "running") return formatProgressLine(run).replace(" · ", "  ");
	if (run.state !== "paused") return stateWord(run);
	const count = run.paused?.length ?? 0;
	return `${stateWord(run)}: ${count} question${count === 1 ? "" : "s"}`;
}

/** The theme color names the overlay paints states with. */
export type OverlayColor = "accent" | "warning" | "success" | "error" | "muted";

/** Wrap `text` in the color of `state`. */
export type OverlayPaint = (state: Run["state"], text: string) => string;

/** Return the theme color of a run state: accent for queued and running, warning for paused, success for done, error for failed, muted for stopped. */
export function overlayStateColor(state: Run["state"]): OverlayColor {
	switch (state) {
		case "queued":
		case "running":
			return "accent";
		case "paused":
			return "warning";
		case "done":
			return "success";
		case "failed":
			return "error";
		case "stopped":
			return "muted";
	}
}

/**
 * Render one overlay row, exactly `width` characters wide: state icon, agent,
 * id, label, progress or state, and the age of last activity at the right edge.
 * `paint` wraps the icon and the state word of the detail after the row is
 * fitted on plain text, so the visible width does not change. A running row has
 * no state word, so only its icon is painted.
 */
export function formatOverlayRow(run: Run, now: number, width: number, paint?: OverlayPaint): string {
	const age = `${formatAge(now - run.lastActivity)} ago`;
	const head = `${OVERLAY_ICONS[run.state]} ${run.agent} ${run.id}  ${run.label}  `;
	const fitted = [...cutText(`${head}${overlayDetail(run)}`, Math.max(0, width - age.length - 1))];
	const gap = Math.max(1, width - fitted.length - age.length);
	const word = { start: [...head].length, length: stateWord(run).length };
	const colored = paint ? paintSegments(run.state, fitted, word, paint) : fitted.join("");
	const rest = [...`${" ".repeat(gap)}${age}`].slice(0, Math.max(width - fitted.length, 0)).join("");
	return `${colored}${rest}`;
}

/** Join the fitted row characters, painting the first one and the `word` span, cut to what fits. */
function paintSegments(state: Run["state"], chars: string[], word: { start: number; length: number }, paint: OverlayPaint): string {
	const wordEnd = Math.min(word.start + word.length, chars.length);
	const icon = paint(state, chars[0] ?? "");
	const middle = chars.slice(1, word.start).join("");
	const painted = chars.slice(word.start, wordEnd).join("");
	return `${icon}${middle}${painted ? paint(state, painted) : ""}${chars.slice(wordEnd).join("")}`;
}

/** Return the runs newest first. */
export function listNewestFirst(runs: Run[]): Run[] {
	return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}

/** One line of the overlay: a run row, a header that titles a group, the `(none)` line of an empty group, or the gap between groups. */
export type OverlayEntry =
	| { kind: "run"; run: Run }
	| { kind: "header"; title: "RUNNING" | "FINISHED" }
	| { kind: "none" }
	| { kind: "gap" };

const RUNNING_STATES: ReadonlySet<Run["state"]> = new Set(["queued", "running", "paused"]);

/**
 * Lay out the overlay: the RUNNING header over the queued, running, and paused
 * runs, a gap, then the FINISHED header over the done, failed, and stopped
 * runs, each group newest first. An empty group holds one `none` entry.
 */
export function layoutOverlay(runs: Run[]): OverlayEntry[] {
	const sorted = listNewestFirst(runs);
	return [
		{ kind: "header", title: "RUNNING" },
		...groupEntries(sorted.filter((run) => RUNNING_STATES.has(run.state))),
		{ kind: "gap" },
		{ kind: "header", title: "FINISHED" },
		...groupEntries(sorted.filter((run) => !RUNNING_STATES.has(run.state))),
	];
}

/** Wrap a group's runs as run entries, or give one `none` entry for an empty group. */
function groupEntries(runs: Run[]): OverlayEntry[] {
	return runs.length === 0 ? [{ kind: "none" }] : runs.map((run) => ({ kind: "run", run }));
}

/** The slice of overlay entries to draw, and how many entries the slice hides on each side. */
export interface EntryWindow {
	start: number;
	entries: OverlayEntry[];
	above: number;
	below: number;
}

/** Return the exclusive end index of the window that begins at `start`, after the markers take their slots. */
function windowEnd(total: number, capacity: number, start: number): number {
	const room = capacity - (start > 0 ? 1 : 0);
	if (start + room >= total) return total;
	return start + Math.max(room - 1, 1);
}

/**
 * Pick the slice of `entries` to draw in `capacity` lines so the entry at
 * `selectedIndex` (or none for -1) stays visible. The window begins at `start`
 * and moves only when the selection would leave it, and never leaves blank
 * lines below the last entry. A `↑ N more` marker takes one line of capacity
 * when entries hide above, and a `↓ N more` marker takes one when they hide
 * below, so the returned entries are fewer than `capacity` by the markers.
 * Return the adjusted `start` to pass back on the next call.
 */
export function windowEntries(entries: OverlayEntry[], selectedIndex: number, capacity: number, start: number): EntryWindow {
	const total = entries.length;
	const lines = Math.max(capacity, 1);
	if (total <= lines) return { start: 0, entries, above: 0, below: 0 };
	let first = Math.max(0, Math.min(start, total - 1));
	if (selectedIndex >= 0 && selectedIndex < first) first = selectedIndex;
	while (first < total - 1 && selectedIndex >= 0 && selectedIndex >= windowEnd(total, lines, first)) first++;
	while (first > 0 && windowEnd(total, lines, first - 1) === total) first--;
	const end = windowEnd(total, lines, first);
	return { start: first, entries: entries.slice(first, end), above: first, below: total - end };
}

/** Return the first line of a text. */
export function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

/** The tool arguments that name a call, as `renderCall` receives them. */
export interface CallLineArgs {
	action?: string;
	label?: string;
	agent?: string;
	task?: string;
	tasks?: { label: string; agent: string; task: string }[];
	id?: string;
	ids?: string[];
	mode?: string;
	answers?: Record<string, string>;
}

/** Render a label as ` · <label>`, or nothing for none. */
function labelSuffix(label: string | undefined): string {
	return label ? ` · ${previewText(label, 80)}` : "";
}

/** Render the start call line: agent and label, with later tasks on their own lines when `expanded` or as a count otherwise. */
function formatStartLine(args: CallLineArgs, expanded: boolean): string {
	const tasks = args.tasks ?? [];
	if (tasks.length === 0) return `subagent start ${args.agent ?? "..."}${labelSuffix(args.label)}`;
	const line = (item: { agent: string; label: string }) => `${item.agent}${labelSuffix(item.label)}`;
	const first = `subagent start ${line(tasks[0])}`;
	if (expanded) return [first, ...tasks.slice(1).map((item) => `  ${line(item)}`)].join("\n");
	return tasks.length > 1 ? `${first} +${tasks.length - 1} more` : first;
}

/** Render the transcript call line for a `subagent` call, one line per task when `expanded` and several were given. */
export function formatCallLine(args: CallLineArgs, options: { expanded?: boolean } = {}): string {
	switch (args.action) {
		case "start":
			return formatStartLine(args, options.expanded ?? false);
		case "wait":
			return `subagent wait ${args.ids?.length ? args.ids.join(", ") : "all"}`;
		case "send":
			return `subagent send ${args.id ?? "..."} · ${args.mode ?? "steer"}`;
		case "stop":
			return `subagent stop ${args.id ?? "..."}`;
		case "resume": {
			const answered = Object.keys(args.answers ?? {}).length;
			const detail = answered > 0 ? ` · answers (${answered})` : labelSuffix(labelOrPreview(args.label, args.task ?? ""));
			return `subagent resume ${args.id ?? "..."}${detail}`;
		}
		case "status":
			return "subagent status";
		default:
			return `subagent ${args.action ?? "..."}`;
	}
}

/** Render the status listing, one line per run, or a notice when there are none. */
export function formatStatus(runs: Run[], now: number): string {
	if (runs.length === 0) return "No subagent runs in this session.";
	return runs.map((run) => formatStatusLine(run, now)).join("\n");
}

/** Collect the text blocks and tool calls of every assistant message, in order. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Sum usage across results. Context tokens are per run and left out. */
export function aggregateUsage(results: SingleResult[]): Omit<UsageStats, "contextTokens"> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}
