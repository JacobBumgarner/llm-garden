/**
 * Subagent tool: delegate tasks to specialized agents, each in its own
 * long-lived `pi --mode rpc` child with an isolated context window.
 *
 * One `subagent` tool whose `action` selects the operation:
 *   - start: `{ label, agent, task }` or `{ tasks: [...] }`. Blocks until the runs
 *     settle and returns their results, or with `background: true` returns
 *     `status: started` at once while the runs keep working. In print and json
 *     modes `background` is ignored, since the process exits when the turn ends.
 *   - status: one line per run started in this session.
 *   - wait: `{ ids?, timeout_s? }` blocks on the named runs, or every running run,
 *     and returns one section per run.
 *   - send: `{ id, message, mode? }` steers a running delegate or queues a follow-up.
 *   - stop: `{ id }` aborts a delegate, or returns the result of one that already finished.
 *   - resume: `{ id, answers }` answers a paused run, `{ id, task, label? }` sends
 *     follow-up work into a finished run's context. Blocks for the reply, or
 *     with `background: true` returns `status: started` at once.
 * Aborting the tool call during a blocking start, wait, or resume detaches it,
 * and so does an interactive message the user types meanwhile: the runs turn
 * into background runs and keep working, and the detached result tells the
 * orchestrator to answer the user.
 *
 * A Run registry created on `session_start` owns every run and is closed on
 * `session_shutdown`, which stops every live delegate. A result courier posts
 * each background result that no `wait` collected as a `subagent-result`
 * message, which wakes an idle orchestrator unless the run was started with
 * `notify: "quiet"`. A live view publishes the queued, running, and paused
 * runs on `pi.events` as `subagent:live`, `/subagents` opens a bordered
 * overlay that lists running runs above finished ones with keys to stop,
 * steer, or answer the selected one, and `alt+a` opens that overlay.
 * `/subagents stop`, the overlay `s` key, and a double Esc stop every running
 * run after a confirm. Each call line names the action, agent, and label, and
 * a foreground call streams turns, tokens, and the last tool call under it. Sessions persist under `PI_SUBAGENT_SESSION_DIR` (default
 * `<agent dir>/subagent-sessions`), and files older than the retention window
 * are swept when a session starts.
 */

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { type BlockedCalls, createBlockedCalls, type DetachReason, shouldDetachOnInput } from "./blocked.ts";
import { createCourier, RESULT_MESSAGE_TYPE, stripNoticeHeader, type ResultMessageDetails } from "./courier.ts";
import {
	aggregateUsage,
	firstLine,
	formatCallLine,
	formatDetached,
	formatProgressLine,
	formatRunResult,
	formatStarted,
	formatStatus,
	formatToolCall,
	formatUsageStats,
	formatWaitSections,
	getDisplayItems,
	isFailedResult,
	isPausedResult,
	snapshotRun,
} from "./format.ts";
import { type Action, parseParams, type StartTask, type SubagentRequest } from "./params.ts";
import { getFinalOutput } from "./pause.ts";
import { type DispatchDefaults, errorText, isActive, isFinished, type Run, RunRegistry } from "./registry.ts";
import { resolveSessionDir, sweepOldSessions } from "./session.ts";
import type { DisplayItem, RunSnapshot, RunState } from "./types.ts";
import { createLiveView, NOTE_MESSAGE_TYPE, registerViewControls } from "./view.ts";

const COLLAPSED_ITEM_COUNT = 10;
const MULTI_RUN_ITEM_COUNT = 5;
const MAX_START_TASKS = 8;

const SESSION_DIR = resolveSessionDir(getAgentDir());

type View = "results" | "started" | "detached" | "status" | "send" | "stop" | "error";
type SubagentArgs = Static<typeof SubagentParams>;
type RequestOf<A extends Action> = Extract<SubagentRequest, { action: A }>;
type ResolvedTask = { task: StartTask; agent: AgentConfig };

interface SubagentDetails {
	action: Action | "invalid";
	view: View;
	/** Session id, state, and usage of every run the call touched. Messages are present only for the results view. */
	runs: RunSnapshot[];
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
	isError?: boolean;
}

type OnUpdate = ((partial: ToolResult) => void) | undefined;

/** What a handler needs from the tool call beyond its parsed request. */
interface Call {
	registry: RunRegistry;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	blocked: BlockedCalls;
	onUpdate: OnUpdate;
	/** False in print and json modes, where the process exits when the turn settles. */
	canBackground: boolean;
	dispatch: DispatchDefaults;
}

const LABEL_DESCRIPTION =
	"Short title for this run, 3 to 7 words, shown in the transcript and used as the delegate's session name. Required with agent and task.";

const TaskItem = Type.Object({
	label: Type.String({ description: "Short title for this task, 3 to 7 words" }),
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
	label: Type.Optional(Type.String({ description: LABEL_DESCRIPTION })),
	action: StringEnum(["start", "status", "wait", "send", "stop", "resume"] as const, {
		description: "What to do. Each action accepts only its own fields.",
	}),
	agent: Type.Optional(Type.String({ description: "start: name of the agent to invoke" })),
	task: Type.Optional(Type.String({ description: "start: the task. resume: follow-up work for a finished run." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "start: several {label, agent, task} at once, instead of label, agent, and task" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"start, resume: return status started at once and let the runs keep working. Default false, so both block until the result is ready.",
		}),
	),
	notify: Type.Optional(
		StringEnum(["wake", "quiet"] as const, { description: "start: how a background result is delivered. Default wake." }),
	),
	cwd: Type.Optional(Type.String({ description: "start: working directory for the agent process" })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: 'start: which agent directories to use. Default "user". "both" adds project-local agents.',
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "start: prompt before running project-local agents. Default true." }),
	),
	id: Type.Optional(Type.String({ description: "send, stop, resume: the session_id of a run" })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "wait: session ids. Omitted means every live run." })),
	timeout_s: Type.Optional(Type.Number({ description: "wait: give up after this many seconds. Default none." })),
	message: Type.Optional(Type.String({ description: "send: the message for a running delegate" })),
	mode: Type.Optional(
		StringEnum(["steer", "follow_up"] as const, {
			description: "send: steer lands after the current tool batch, follow_up after the current turn. Default steer.",
		}),
	),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "resume: answers for a paused run's questions, keyed by question id: an option label or free text.",
		}),
	),
});

/** Build a plain text result with its details. */
function textResult(action: SubagentDetails["action"], view: View, text: string, runs: RunSnapshot[] = []): ToolResult {
	return { content: [{ type: "text", text }], details: { action, view, runs } };
}

/** Build an error result that the model sees as a failed call. */
function errorResult(action: SubagentDetails["action"], text: string): ToolResult {
	return { ...textResult(action, "error", text), isError: true };
}

/** Build the results view: one section per run when `sectioned`, else the single-run shape. */
function resultsView(action: Action, runs: Run[], sectioned: boolean): ToolResult {
	const snapshots = runs.map((run) => snapshotRun(run, true));
	const text = sectioned ? formatWaitSections(snapshots) : formatRunResult(snapshots[0]);
	const failed = !sectioned && snapshots[0].state === "failed";
	return { ...textResult(action, "results", text, snapshots), ...(failed ? { isError: true } : {}) };
}

/** Build the started notice for runs that keep working after the call returns. */
function startedView(action: Action, runs: Run[]): ToolResult {
	const snapshots = runs.map((run) => snapshotRun(run, false));
	return textResult(action, "started", formatStarted(snapshots), snapshots);
}

/** Stream the latest output of the given runs through `onUpdate` as they change. Return the unsubscribe function. */
function streamUpdates(registry: RunRegistry, action: Action, runs: Run[], onUpdate: NonNullable<OnUpdate>): () => void {
	return registry.on("change", (changed) => {
		if (!runs.some((run) => run.id === changed.id)) return;
		const snapshots = runs.map((run) => snapshotRun(run, true));
		onUpdate(textResult(action, "results", getFinalOutput(changed.messages) || "(running...)", snapshots));
	});
}

/** Release the wait on each run, which makes it a background run, and build the detached notice. */
function detachRuns(registry: RunRegistry, action: Action, runs: Run[], reason: DetachReason): ToolResult {
	for (const run of runs) registry.detach(run.id);
	const snapshots = runs.map((run) => snapshotRun(run, false));
	return textResult(action, "detached", formatDetached(snapshots, reason), snapshots);
}

/**
 * Block until every run settles and return the results view, streaming partial
 * results as the runs change. When the call's `signal` aborts or the call is
 * detached through the blocked-call tracker, detach the runs instead.
 */
async function awaitRuns(
	call: Call,
	action: Action,
	runs: Run[],
	options: { sectioned: boolean; timeoutMs?: number },
): Promise<ToolResult> {
	const { registry, signal, onUpdate } = call;
	const unsubscribe = onUpdate ? streamUpdates(registry, action, runs, onUpdate) : undefined;
	const ids = runs.map((run) => run.id);
	const own = new AbortController();
	const leave = call.blocked.enter((reason: DetachReason) => own.abort(reason));
	const composed = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
	try {
		const settled = await registry.wait(ids, options.timeoutMs, composed);
		return resultsView(action, settled, options.sectioned);
	} catch (err) {
		if (!composed.aborted) return errorResult(action, errorText(err));
		const reason: DetachReason = own.signal.aborted ? own.signal.reason : "abort";
		return detachRuns(registry, action, runs, reason);
	} finally {
		leave();
		unsubscribe?.();
	}
}

/** Pair each requested task with its agent, or return the error naming the unknown agents. */
function resolveTasks(request: RequestOf<"start">, agents: AgentConfig[]): ResolvedTask[] | ToolResult {
	const resolved: ResolvedTask[] = [];
	const unknown: string[] = [];
	for (const task of request.tasks) {
		const agent = agents.find((candidate) => candidate.name === task.agent);
		if (agent) resolved.push({ task, agent });
		else unknown.push(`"${task.agent}"`);
	}
	if (unknown.length === 0) return resolved;
	const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
	return errorResult("start", `Unknown agent: ${unknown.join(", ")}. Available agents: ${available}.`);
}

/** Ask the user to approve project-local agents. Return true when none need approval or the user agrees. */
async function approveProjectAgents(
	request: RequestOf<"start">,
	ctx: ExtensionContext,
	resolved: ResolvedTask[],
	projectAgentsDir: string | null,
): Promise<boolean> {
	const names = [...new Set(resolved.filter((r) => r.agent.source === "project").map((r) => r.agent.name))];
	if (names.length === 0 || !request.confirmProjectAgents || !ctx.hasUI || ctx.isProjectTrusted()) return true;
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names.join(", ")}\nSource: ${projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

/** Start every task, collecting the runs that started and a line for each that did not. */
async function startTasks(
	request: RequestOf<"start">,
	call: Call,
	resolved: ResolvedTask[],
): Promise<{ started: Run[]; failures: string[] }> {
	const background = request.background && call.canBackground;
	const started: Run[] = [];
	const failures: string[] = [];
	for (const { task, agent } of resolved) {
		try {
			const run = await call.registry.start({
				agent,
				label: task.label,
				task: task.task,
				cwd: task.cwd,
				agentScope: request.agentScope,
				background,
				notify: request.notify,
				dispatch: call.dispatch,
			});
			started.push(run);
		} catch (err) {
			failures.push(`${task.agent}: ${errorText(err)}`);
		}
	}
	return { started, failures };
}

/** Start the requested runs, then return the started notice or block for their results. */
async function handleStart(request: RequestOf<"start">, call: Call): Promise<ToolResult> {
	if (request.tasks.length > MAX_START_TASKS) {
		return errorResult("start", `Too many tasks (${request.tasks.length}). Max is ${MAX_START_TASKS}.`);
	}
	const discovery = discoverAgents(call.ctx.cwd, request.agentScope);
	const resolved = resolveTasks(request, discovery.agents);
	if (!Array.isArray(resolved)) return resolved;
	if (!(await approveProjectAgents(request, call.ctx, resolved, discovery.projectAgentsDir))) {
		return textResult("start", "error", "Canceled: project-local agents not approved.");
	}
	const { started, failures } = await startTasks(request, call, resolved);
	if (started.length === 0) return errorResult("start", failures.join("\n"));
	const result =
		request.background && call.canBackground
			? startedView("start", started)
			: await awaitRuns(call, "start", started, { sectioned: started.length > 1 });
	if (failures.length > 0) result.content[0].text += `\n\nNot started:\n${failures.join("\n")}`;
	return result;
}

/** List every run started in this session. */
function handleStatus(call: Call): ToolResult {
	const runs = call.registry.list();
	return textResult("status", "status", formatStatus(runs, Date.now()), runs.map((run) => snapshotRun(run, false)));
}

/** Block on the named runs, or every queued or running run when none are named. */
async function handleWait(request: RequestOf<"wait">, call: Call): Promise<ToolResult> {
	const all = call.registry.list();
	const ids = request.ids ?? all.filter(isActive).map((run) => run.id);
	const targets = ids.map((id) => all.find((run) => run.id === id));
	const missing = ids.filter((_, index) => !targets[index]);
	if (missing.length > 0) return errorResult("wait", `Unknown subagent session: ${missing.join(", ")}.`);
	if (targets.length === 0) return textResult("wait", "results", formatWaitSections([]));
	return awaitRuns(call, "wait", targets as Run[], { sectioned: true, timeoutMs: request.timeoutMs });
}

/** Deliver a message to a running delegate. */
async function handleSend(request: RequestOf<"send">, call: Call): Promise<ToolResult> {
	const disposition = await call.registry.send(request.id, request.message, request.mode);
	return textResult("send", "send", `${request.mode} ${request.id}: ${disposition}`);
}

/**
 * Abort a delegate. The tool result reports the stop, so no result message is
 * posted for it. A run that already finished is left alone and its result is
 * returned instead, claiming it from the courier unless a wait holds it.
 */
async function handleStop(request: RequestOf<"stop">, call: Call): Promise<ToolResult> {
	const { registry } = call;
	const run = registry.list().find((candidate) => candidate.id === request.id);
	if (run && isFinished(run)) return finishedStopResult(registry, run);
	await registry.stop(request.id, { delivered: true });
	return textResult("stop", "stop", `stopped ${request.id}`);
}

/** Return a finished run's result for a stop, claiming it from the courier unless a wait holds it. */
function finishedStopResult(registry: RunRegistry, run: Run): ToolResult {
	if (run.waiters === 0) registry.markDelivered(run.id);
	return resultsView("stop", [run], false);
}

/**
 * Answer a paused run or send follow-up work into a finished one, then block
 * for the result. With `background: true` in a mode that allows it, return the
 * started notice at once instead.
 */
async function handleResume(request: RequestOf<"resume">, call: Call): Promise<ToolResult> {
	const { dispatch } = call;
	const input = request.answers
		? { answers: request.answers, dispatch }
		: { task: request.task as string, label: request.label, dispatch };
	const run = await call.registry.resume(request.id, input);
	if (request.background === true && call.canBackground) return startedView("resume", [run]);
	return awaitRuns(call, "resume", [run], { sectioned: false });
}

/** Run the handler for the request's action. */
function dispatchRequest(request: SubagentRequest, call: Call): Promise<ToolResult> | ToolResult {
	switch (request.action) {
		case "start":
			return handleStart(request, call);
		case "status":
			return handleStatus(call);
		case "wait":
			return handleWait(request, call);
		case "send":
			return handleSend(request, call);
		case "stop":
			return handleStop(request, call);
		case "resume":
			return handleResume(request, call);
	}
}

/** Pick the themed icon for a run's state. */
function stateIcon(run: { state: RunState }, theme: Theme): string {
	switch (run.state) {
		case "queued":
		case "running":
			return theme.fg("warning", "⏳");
		case "paused":
			return theme.fg("warning", "⏸");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("muted", "■");
		default:
			return theme.fg("success", "✓");
	}
}

/** Render the note after a run's header: its pause, stopped, or queued state, and failure reason. */
function runNote(run: RunSnapshot, theme: Theme): string {
	let note = "";
	if (isPausedResult(run)) {
		const count = run.paused?.length ?? 0;
		note = theme.fg("warning", ` paused on ${count} question${count === 1 ? "" : "s"}`);
	} else if (run.state === "stopped" || run.state === "queued") {
		note = theme.fg("muted", ` ${run.state}`);
	}
	if (isFailedResult(run) && run.stopReason) note += ` ${theme.fg("error", `[${run.stopReason}]`)}`;
	return note;
}

/** Render a run's header line: state icon, bold agent, its label, then `tail`. */
function headerLine(run: { agent: string; label: string; state: RunState }, tail: string, theme: Theme): string {
	return `${stateIcon(run, theme)} ${theme.fg("toolTitle", theme.bold(run.agent))} ${theme.fg("accent", run.label)}${tail}`;
}

/** Render one run's header: icon, agent, label, source, id, and its note. */
function runHeader(run: RunSnapshot, theme: Theme): string {
	const origin = theme.fg("muted", ` (${run.agentSource}) ${run.sessionId}`);
	return headerLine(run, origin + runNote(run, theme), theme);
}

/** Render a tool call item as an arrowed one-line preview. */
function toolCallLine(item: Extract<DisplayItem, { type: "toolCall" }>, theme: Theme): string {
	return theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme));
}

/** Render display items as themed lines, keeping the last `limit` items. */
function renderItems(items: DisplayItem[], theme: Theme, limit: number): string {
	const lines: string[] = [];
	if (items.length > limit) lines.push(theme.fg("muted", `... ${items.length - limit} earlier items`));
	for (const item of items.slice(-limit)) {
		if (item.type === "toolCall") lines.push(toolCallLine(item, theme));
		else lines.push(theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n")));
	}
	return lines.join("\n");
}

/** Render a collapsed run's body: its error, a placeholder, or its recent items. */
function collapsedBody(run: RunSnapshot, theme: Theme, limit: number): string {
	if (isFailedResult(run) && run.errorMessage) return theme.fg("error", `Error: ${run.errorMessage}`);
	const items = getDisplayItems(run.messages);
	if (items.length > 0) return renderItems(items, theme, limit);
	return theme.fg("muted", isActive(run) ? "(running...)" : "(no output)");
}

/** Render one run collapsed: header, body, and usage. */
function renderRunCollapsed(run: RunSnapshot, theme: Theme, limit: number): string {
	const lines = [runHeader(run, theme), collapsedBody(run, theme, limit)];
	const usage = formatUsageStats(run.usage, run.model);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines.join("\n");
}

/** Add one run expanded to a container: header, task, tool calls, final text as markdown, and usage. */
function addRunExpanded(container: Container, run: RunSnapshot, theme: Theme): void {
	const toolCalls = getDisplayItems(run.messages).filter((item) => item.type === "toolCall");
	const finalOutput = getFinalOutput(run.messages);
	const text = (value: string) => container.addChild(new Text(value, 0, 0));
	text(runHeader(run, theme));
	if (isFailedResult(run) && run.errorMessage) text(theme.fg("error", `Error: ${run.errorMessage}`));
	container.addChild(new Spacer(1));
	text(theme.fg("muted", "─── Task ───"));
	text(theme.fg("dim", run.task));
	container.addChild(new Spacer(1));
	text(theme.fg("muted", "─── Output ───"));
	if (toolCalls.length === 0 && !finalOutput) text(theme.fg("muted", "(no output)"));
	for (const item of toolCalls) text(toolCallLine(item, theme));
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, getMarkdownTheme()));
	}
	const usage = formatUsageStats(run.usage, run.model);
	if (usage) {
		container.addChild(new Spacer(1));
		text(theme.fg("dim", usage));
	}
}

/** Format the usage total across several runs, or an empty string for one run or no usage. */
function usageTotal(runs: RunSnapshot[]): string {
	return runs.length > 1 ? formatUsageStats(aggregateUsage(runs)) : "";
}

/** Render the results view expanded: every run in full, with a usage total for several. */
function renderResultsExpanded(runs: RunSnapshot[], theme: Theme): Container {
	const container = new Container();
	runs.forEach((run, index) => {
		if (index > 0) container.addChild(new Spacer(1));
		addRunExpanded(container, run, theme);
	});
	const total = usageTotal(runs);
	if (total) container.addChild(new Text(theme.fg("dim", `Total: ${total}`), 0, 0));
	return container;
}

/** Render the results view collapsed: recent items per run, a usage total for several, and an expand hint when anything is hidden. */
function renderResultsCollapsed(runs: RunSnapshot[], theme: Theme): Text {
	const limit = runs.length === 1 ? COLLAPSED_ITEM_COUNT : MULTI_RUN_ITEM_COUNT;
	const sections = runs.map((run) => renderRunCollapsed(run, theme, limit));
	const total = usageTotal(runs);
	if (total) sections.push(theme.fg("dim", `Total: ${total}`));
	const hidden = runs.length > 1 || runs.some((run) => getDisplayItems(run.messages).length > limit);
	if (hidden) sections.push(theme.fg("muted", "(Ctrl+O to expand)"));
	return new Text(sections.join("\n\n"), 0, 0);
}

/** Render the started or detached notice as one line per run. */
function renderNotice(note: string, runs: RunSnapshot[], theme: Theme): Text {
	const lines = runs.map(
		(run) => `${theme.fg("accent", "▶")} ${theme.fg("toolTitle", run.agent)} ${theme.fg("muted", `${run.sessionId} ${note}`)}`,
	);
	return new Text(lines.join("\n"), 0, 0);
}

/** Render the transcript line for a tool call: the bold tool name, the accented action and target, and any task lines dim. */
function renderCall(args: SubagentArgs, theme: Theme, expanded: boolean): Text {
	const [first, ...rest] = formatCallLine(args, { expanded }).split("\n");
	const head = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", first.slice("subagent ".length));
	return new Text([head, ...rest.map((line) => theme.fg("dim", line))].join("\n"), 0, 0);
}

/** Render the live progress of a running call: one line per run, led by the agent and id when several run. */
function renderProgress(runs: RunSnapshot[], theme: Theme): Text {
	const lines = runs.map((run) => {
		const lead = runs.length > 1 ? `${run.agent} ${run.sessionId}  ` : "";
		return theme.fg("dim", `${lead}${formatProgressLine(run)}`);
	});
	return new Text(lines.join("\n") || theme.fg("muted", "(starting...)"), 0, 0);
}

/** Render a failed result collapsed as the first line of its error. */
function renderErrorLine(details: SubagentDetails, text: string, theme: Theme): Text {
	const run = details.view === "results" ? details.runs[0] : undefined;
	const message = run ? run.errorMessage || run.stderr || text : text;
	return new Text(theme.fg("error", firstLine(message)), 0, 0);
}

/** Render a tool result by its view. */
function renderResult(details: SubagentDetails, text: string, expanded: boolean, theme: Theme): Container | Text {
	switch (details.view) {
		case "results":
			if (details.runs.length === 0) return new Text(theme.fg("muted", text), 0, 0);
			return expanded ? renderResultsExpanded(details.runs, theme) : renderResultsCollapsed(details.runs, theme);
		case "started":
			return renderNotice("started", details.runs, theme);
		case "detached":
			return renderNotice("detached, still working", details.runs, theme);
		case "status":
			return new Text(theme.fg("dim", text), 0, 0);
		case "error":
			return new Text(theme.fg("error", text), 0, 0);
		default:
			return new Text(theme.fg("muted", text), 0, 0);
	}
}

/** Render the text of a custom message's content. */
function messageText(content: string | { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** Render a posted result message: one header line per run, and the full sections when expanded. */
function renderResultMessage(
	content: string | { type: string; text?: string }[],
	details: ResultMessageDetails | undefined,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Box {
	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const headers = (details?.runs ?? []).map((run) => {
		const usage = formatUsageStats(run.usage, run.model);
		const tail = theme.fg("muted", ` ${run.sessionId} ${run.state}`) + (usage ? theme.fg("dim", ` ${usage}`) : "");
		return headerLine(run, tail, theme);
	});
	const title = theme.fg("customMessageLabel", theme.bold("subagent results"));
	box.addChild(new Text([title, ...headers].join("\n"), 0, 0));
	if (options.expanded) {
		box.addChild(new Spacer(1));
		box.addChild(new Markdown(stripNoticeHeader(messageText(content)).trim(), 0, 0, getMarkdownTheme()));
	} else {
		box.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
	}
	return box;
}

export default function (pi: ExtensionAPI) {
	let registry: RunRegistry | undefined;
	let disposers: (() => void)[] = [];
	let swept = false;
	let latestCtx: ExtensionContext | undefined;
	const blocked = createBlockedCalls();

	/** Return the live registry, creating one with its courier and live view when none exists or the last was closed. */
	const getRegistry = (ctx: ExtensionContext): RunRegistry => {
		if (registry) return registry;
		const created = new RunRegistry({
			sessionDir: SESSION_DIR,
			defaultCwd: ctx.cwd,
			findAgent: (name: string, scope: AgentScope, cwd: string) =>
				discoverAgents(cwd, scope).agents.find((agent) => agent.name === name),
		});
		registry = created;
		disposers = [
			createCourier(created, pi, {
				isIdle: () => latestCtx?.isIdle() ?? true,
				onTurnEnd: (fn) =>
					pi.on("agent_end", (_event, ctx) => {
						latestCtx = ctx;
						fn();
					}),
			}),
			createLiveView(pi, created, () => latestCtx),
		];
		return created;
	};

	pi.registerMessageRenderer<ResultMessageDetails>(RESULT_MESSAGE_TYPE, (message, options, theme) =>
		renderResultMessage(message.content, message.details, options, theme),
	);

	pi.registerMessageRenderer<undefined>(NOTE_MESSAGE_TYPE, (message, _options, theme) =>
		new Text(theme.fg("dim", messageText(message.content)), 1, 0),
	);

	registerViewControls(pi, () => registry);

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		getRegistry(ctx);
		if (swept) return;
		swept = true;
		void sweepOldSessions(SESSION_DIR);
	});

	pi.on("input", (ev) => {
		if (shouldDetachOnInput(ev)) blocked.detachAll("user-input");
		return { action: "continue" };
	});

	pi.on("session_shutdown", async () => {
		blocked.detachAll("abort");
		const closing = registry;
		registry = undefined;
		latestCtx = undefined;
		for (const dispose of disposers) dispose();
		disposers = [];
		await closing?.close();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context. `action` selects the operation and each action accepts only its own fields.",
			"start: { label, agent, task } or { tasks: [{ label, agent, task }] } runs delegates and returns their results. With background: true it returns status started and a session_id at once, and the delegate keeps working.",
			"status: lists every run in this session. wait: { ids?, timeout_s? } blocks until the runs settle and returns their results.",
			"send: { id, message, mode? } messages a running delegate. stop: { id } aborts one.",
			'Every result ends with a session_id. To continue a finished subagent with more work in the same context, call { action: "resume", id, task, label? }. Prefer that over a fresh run that would have to rediscover everything.',
			"A subagent that needs a decision pauses: the result reads `status: paused` with its questions and a resume_id.",
			'Answer from your own context, or ask the user first, then call { action: "resume", id, answers }.',
			"Sessions are kept 7 days.",
			`Default agent scope is "user" (the plugin's bundled agents plus ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const parsed = parseParams(params as Record<string, unknown>);
			if (!parsed.ok) return errorResult("invalid", parsed.error);
			latestCtx = ctx;
			const call: Call = {
				registry: getRegistry(ctx),
				ctx,
				signal,
				blocked,
				onUpdate: onUpdate as OnUpdate,
				canBackground: ctx.mode === "tui" || ctx.mode === "rpc",
				dispatch: {
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					thinkingLevel: ctx.thinkingLevel,
				},
			};
			try {
				return await dispatchRequest(parsed.request, call);
			} catch (err) {
				return errorResult(parsed.request.action, errorText(err));
			}
		},

		renderCall: (args, theme, context) => renderCall(args, theme, context.expanded),

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "(no output)";
			if (!details) return new Text(text, 0, 0);
			if (isPartial) return renderProgress(details.runs, theme);
			if (context.isError && !expanded) return renderErrorLine(details, text, theme);
			return renderResult(details, text, expanded, theme);
		},
	});
}
