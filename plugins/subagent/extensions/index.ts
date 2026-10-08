/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports four modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *   - Resume: { resume: "sub-xxxx", answers: {...} } or { resume: "sub-xxxx", task: "..." }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Every subagent runs in its own persisted session under a dedicated directory
 * (`PI_SUBAGENT_SESSION_DIR`, default `<agent dir>/subagent-sessions`). Every
 * result carries the run's `session_id`, and a session can be reopened two ways:
 *   - When a subagent calls `ask`, the `ask` extension blocks the call and ends
 *     the run; this tool returns `status: paused` with the questions and a
 *     `resume_id`. The orchestrator answers with `{ resume, answers }`, which
 *     reopens the session with the answers as the next user message.
 *   - When a run completes, the orchestrator can send follow-up work into the
 *     same context with `{ resume, task }`, so the subagent keeps everything it
 *     already read and wrote.
 * Session files older than the retention window are swept when the extension
 * loads.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatAnswersMessage, PAUSE_MARKER } from "../../ask/extensions/pause.ts";
import type { AskQuestion } from "../../ask/extensions/types.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { detectPause, formatPaused as formatPausedRun, getFinalOutput } from "./pause.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const SESSION_DIR = process.env.PI_SUBAGENT_SESSION_DIR ?? path.join(getAgentDir(), "subagent-sessions");
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const SUBAGENT_PROTOCOL = [
	"## Working as a subagent",
	"You run headless under an orchestrating agent; nobody is at the terminal. When a decision needs context you do not",
	"have, call `ask` with the open questions exactly as you would for a user. Your turn then ends and the tool result",
	`reads "${PAUSE_MARKER} ..."; that is expected. The orchestrator's answers arrive as your next message inside`,
	"<orchestrator-answers>; continue from there. Never act on an open question before the answers arrive.",
	"After you finish, the orchestrator may reopen this session with a follow-up task; treat it as a continuation of",
	"your work here, not a fresh assignment.",
].join("\n");

/** What a resume needs to know about the run it continues. Stored beside the session file. */
interface SessionMeta {
	agent: string;
	task: string;
	cwd?: string;
	agentScope: AgentScope;
	step?: number;
	/** Chain steps still to run once this one completes. */
	chainRemaining?: { agent: string; task: string; cwd?: string }[];
	/** Questions recorded at the last pause, so answers can be matched to ids. Cleared when the run completes. */
	questions?: AskQuestion[];
}

/** The footer appended to a completed run's output so the orchestrator can continue the session. */
function formatSessionFooter(result: SingleResult): string {
	return [
		"---",
		`session_id: ${result.sessionId} (agent: ${result.agent})`,
		`Follow up in this context: subagent({ resume: "${result.sessionId}", task: "..." })`,
	].join("\n");
}

/** A completed run's final text with the session footer. */
function formatCompleted(result: SingleResult): string {
	return `${getFinalOutput(result.messages) || "(no output)"}\n\n${formatSessionFooter(result)}`;
}

function metaPath(sessionId: string): string {
	return path.join(SESSION_DIR, `${sessionId}.meta.json`);
}

async function writeMeta(sessionId: string, meta: SessionMeta): Promise<void> {
	await fs.promises.mkdir(SESSION_DIR, { recursive: true });
	await fs.promises.writeFile(metaPath(sessionId), JSON.stringify(meta, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function readMeta(sessionId: string): SessionMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(metaPath(sessionId), "utf-8")) as SessionMeta;
	} catch {
		return undefined;
	}
}

function newSessionId(): string {
	return `sub-${randomUUID().slice(0, 8)}`;
}

/** Delete session and meta files older than the retention window. Errors are ignored. */
async function sweepOldSessions(): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(SESSION_DIR);
	} catch {
		return;
	}
	const cutoff = Date.now() - SESSION_RETENTION_MS;
	for (const entry of entries) {
		const file = path.join(SESSION_DIR, entry);
		try {
			const stat = await fs.promises.stat(file);
			if (stat.isFile() && stat.mtimeMs < cutoff) await fs.promises.unlink(file);
		} catch {
			/* ignore */
		}
	}
}


function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
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

function formatToolCall(
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

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionId: string;
	/** Questions the subagent paused on; the run must be resumed with answers. */
	paused?: AskQuestion[];
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function isPausedResult(result: SingleResult): boolean {
	return result.paused !== undefined && !isFailedResult(result);
}

function formatPaused(result: SingleResult): string {
	return formatPausedRun({
		agent: result.agent,
		sessionId: result.sessionId,
		questions: result.paused ?? [],
		lastOutput: getFinalOutput(result.messages),
	});
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	if (isPausedResult(result)) return formatPaused(result);
	return formatCompleted(result);
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface RunOptions {
	defaultCwd: string;
	dispatchDefaults: DispatchDefaults;
	agents: AgentConfig[];
	agentName: string;
	/** The task as the orchestrator stated it; shown in the transcript and stored in the session meta. */
	task: string;
	/** The user message for this run: the task on a fresh run, the answers on a resume. */
	prompt: string;
	sessionId: string;
	cwd: string | undefined;
	step: number | undefined;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Run one subagent process to completion or pause. Requires the session meta
 * for `sessionId` to be written by the caller; this only sets `paused` on the
 * result and records the questions in the meta when the run pauses.
 */
async function runSingleAgent(options: RunOptions): Promise<SingleResult> {
	const { defaultCwd, dispatchDefaults, agents, agentName, task, prompt, sessionId, cwd, step, signal, onUpdate, makeDetails } = options;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			sessionId,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--session-dir", SESSION_DIR, "--session-id", sessionId];
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		step,
		sessionId,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		const systemPrompt = [agent.systemPrompt.trim(), SUBAGENT_PROTOCOL].filter(Boolean).join("\n\n");
		const tmp = await writePromptToTempFile(agent.name, systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		args.push(prompt);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		const paused = detectPause(currentResult.messages);
		if (paused) currentResult.paused = paused;
		const meta = readMeta(sessionId);
		if (meta) await writeMeta(sessionId, { ...meta, questions: paused });
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (single mode), or the follow-up task when paired with `resume`." }),
	),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	resume: Type.Optional(
		Type.String({
			description:
				"The session_id / resume_id of a previous subagent run. Pair with `answers` for a paused run, or `task` to send follow-up work into a completed run's context. No `agent`, `tasks`, or `chain`.",
		}),
	),
	answers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Answers for a paused subagent's questions, keyed by question id: an option label or free text.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	void sweepOldSessions();

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), resume (resume + answers | task).",
			"Every result ends with a session_id. To continue a finished subagent with more work in the same context (fixes, follow-up questions, the next step of the same job), call { resume: session_id, task }; prefer that over a fresh run that would have to rediscover everything.",
			"A subagent that needs a decision pauses: the result reads `status: paused` with its questions and a resume_id.",
			"Answer from your own context, or ask the user first, then call this tool again with { resume, answers }.",
			"Sessions are kept 7 days.",
			`Default agent scope is "user" (the plugin's bundled agents plus ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasResume = Boolean(params.resume);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasResume);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
					},
					],
					details: makeDetails("single")([]),
				};
			}

			/** Run the chain steps after a completed one, threading `{previous}`; returns the tool result. */
			const continueChain = async (
				results: SingleResult[],
				remaining: { agent: string; task: string; cwd?: string }[],
				firstStep: number,
			): Promise<AgentToolResult<SubagentDetails>> => {
				let previousOutput = getFinalOutput(results[results.length - 1].messages);
				for (let i = 0; i < remaining.length; i++) {
					const step = remaining[i];
					const stepNumber = firstStep + i;
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({ content: partial.content, details: makeDetails("chain")([...results, currentResult]) });
								}
							}
						: undefined;
					const sessionId = newSessionId();
					await writeMeta(sessionId, {
						agent: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						agentScope,
						step: stepNumber,
						chainRemaining: remaining.slice(i + 1),
					});
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						dispatchDefaults,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						prompt: `Task: ${taskWithContext}`,
						sessionId,
						cwd: step.cwd,
						step: stepNumber,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
					});
					results.push(result);

					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${stepNumber} (${step.agent}): ${getResultOutput(result)}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					if (isPausedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain paused at step ${stepNumber} (${step.agent}).\n${formatPaused(result)}` }],
							details: makeDetails("chain")(results),
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: formatCompleted(results[results.length - 1]) }],
					details: makeDetails("chain")(results),
				};
			};

			if (params.resume) {
				const meta = readMeta(params.resume);
				if (!meta) {
					return {
						content: [{ type: "text", text: `Unknown resume_id "${params.resume}". It may have expired (sessions are kept 7 days) or never existed.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				const isChain = meta.chainRemaining !== undefined;
				const mode = isChain ? "chain" : "single";
				const isPaused = (meta.questions?.length ?? 0) > 0;
				const hasAnswers = Object.keys(params.answers ?? {}).length > 0;
				const invalid = (message: string): AgentToolResult<SubagentDetails> => ({
					content: [{ type: "text", text: message }],
					details: makeDetails(mode)([]),
					isError: true,
				});
				if (isPaused && !hasAnswers) {
					return invalid(
						`Session "${params.resume}" is paused on questions (${(meta.questions ?? []).map((q) => q.id).join(", ")}). Resume it with { resume, answers }, not a task.`,
					);
				}
				if (!isPaused && !params.task) {
					return invalid(
						`Session "${params.resume}" completed and has no open questions. Resume it with { resume, task } to send follow-up work.`,
					);
				}
				const prompt = isPaused
					? formatAnswersMessage(meta.questions ?? [], params.answers ?? {})
					: `Follow-up task (continuing your previous work in this session): ${params.task}`;
				const task = isPaused ? meta.task : (params.task as string);
				if (!isPaused) await writeMeta(params.resume, { ...meta, task });
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents,
					agentName: meta.agent,
					task,
					prompt,
					sessionId: params.resume,
					cwd: meta.cwd,
					step: meta.step,
					signal,
					onUpdate,
					makeDetails: makeDetails(mode),
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
						details: makeDetails(mode)([result]),
						isError: true,
					};
				}
				if (isPausedResult(result)) {
					return { content: [{ type: "text", text: formatPaused(result) }], details: makeDetails(mode)([result]) };
				}
				if (isPaused && isChain && meta.chainRemaining && meta.chainRemaining.length > 0) {
					return continueChain([result], meta.chainRemaining, (meta.step ?? 1) + 1);
				}
				return {
					content: [{ type: "text", text: formatCompleted(result) }],
					details: makeDetails(mode)([result]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const [first, ...rest] = params.chain;
				const sessionId = newSessionId();
				await writeMeta(sessionId, { agent: first.agent, task: first.task, cwd: first.cwd, agentScope, step: 1, chainRemaining: rest });
				const chainUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							const currentResult = partial.details?.results[0];
							if (currentResult) onUpdate({ content: partial.content, details: makeDetails("chain")([currentResult]) });
						}
					: undefined;
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents,
					agentName: first.agent,
					task: first.task,
					prompt: `Task: ${first.task}`,
					sessionId,
					cwd: first.cwd,
					step: 1,
					signal,
					onUpdate: chainUpdate,
					makeDetails: makeDetails("chain"),
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Chain stopped at step 1 (${first.agent}): ${getResultOutput(result)}` }],
						details: makeDetails("chain")([result]),
						isError: true,
					};
				}
				if (isPausedResult(result)) {
					return {
						content: [{ type: "text", text: `Chain paused at step 1 (${first.agent}).\n${formatPaused(result)}` }],
						details: makeDetails("chain")([result]),
					};
				}
				return continueChain([result], rest, 2);
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						sessionId: "",
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const sessionId = newSessionId();
					await writeMeta(sessionId, { agent: t.agent, task: t.task, cwd: t.cwd, agentScope });
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						dispatchDefaults,
						agents,
						agentName: t.agent,
						task: t.task,
						prompt: `Task: ${t.task}`,
						sessionId,
						cwd: t.cwd,
						step: undefined,
						signal,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r) && !isPausedResult(r)).length;
				const pausedCount = results.filter(isPausedResult).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: isPausedResult(r)
							? "paused"
							: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				const headline = `Parallel: ${successCount}/${results.length} succeeded${pausedCount > 0 ? `, ${pausedCount} paused (resume each with its resume_id)` : ""}`;
				return {
					content: [{ type: "text", text: `${headline}\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const sessionId = newSessionId();
				await writeMeta(sessionId, { agent: params.agent, task: params.task, cwd: params.cwd, agentScope });
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					dispatchDefaults,
					agents,
					agentName: params.agent,
					task: params.task,
					prompt: `Task: ${params.task}`,
					sessionId,
					cwd: params.cwd,
					step: undefined,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				if (isPausedResult(result)) {
					return { content: [{ type: "text", text: formatPaused(result) }], details: makeDetails("single")([result]) };
				}
				return {
					content: [{ type: "text", text: formatCompleted(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.resume) {
				const answered = Object.keys(args.answers ?? {});
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `resume ${args.resume}`);
				if (answered.length > 0) text += theme.fg("dim", ` answering ${answered.join(", ")}`);
				else if (args.task) {
					const preview = args.task.length > 40 ? `${args.task.slice(0, 40)}...` : args.task;
					text += theme.fg("dim", ` follow-up: ${preview}`);
				}
				return new Text(text, 0, 0);
			}
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const isPaused = isPausedResult(r);
				const icon = isError ? theme.fg("error", "✗") : isPaused ? theme.fg("warning", "⏸") : theme.fg("success", "✓");
				const pausedNote = isPaused
					? theme.fg("warning", ` paused on ${r.paused?.length ?? 0} question${r.paused?.length === 1 ? "" : "s"} — ${r.sessionId}`)
					: "";
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${pausedNote}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${pausedNote}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
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
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
