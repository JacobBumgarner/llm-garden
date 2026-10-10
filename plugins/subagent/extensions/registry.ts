/**
 * Run registry: owns every delegate started in this pi session. Drives each
 * run's state from its Delegate client's events, decides at each settle whether
 * a pending `wait` or the undelivered set gets the result, enforces the running
 * and live-child caps, retires idle children, respawns retired ones on their
 * session file, and emits a change event. Imports types only from pi packages.
 */

import * as fs from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatAnswersMessage } from "../../ask/extensions/pause.ts";
import type { AskQuestion } from "../../ask/extensions/types.ts";
import type { AgentConfig, AgentScope } from "./agents.ts";
import { labelOrPreview } from "./format.ts";
import { detectPause } from "./pause.ts";
import { DelegateClient, type DelegateExit } from "./rpc.ts";
import { newSessionId, readMeta, writeMeta } from "./session.ts";
import { buildChildArgs, SUBAGENT_PROTOCOL, writePromptToTempFile } from "./spawn.ts";
import type { Run, RunClient, UsageStats } from "./types.ts";

export type { Run, RunClient, RunState } from "./types.ts";

export const MAX_RUNNING = 6;
export const MAX_LIVE = 8;
export const DONE_IDLE_MS = 10 * 60 * 1000;
export const PAUSED_IDLE_MS = 30 * 60 * 1000;

/** The orchestrator's own model and thinking level, used by agents that name no model. */
export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunSpec {
	label: string;
	agent: AgentConfig;
	task: string;
	cwd?: string;
	agentScope: AgentScope;
	background?: boolean;
	notify?: "wake" | "quiet";
	dispatch?: DispatchDefaults;
}

export type ResumeInput = ({ answers: Record<string, string>; task?: undefined } | { task: string; label?: string; answers?: undefined }) & {
	/** Replaces the dispatch defaults for a respawned child. */
	dispatch?: DispatchDefaults;
};

/** The flags for one child and the cleanup for anything written to build them. */
export interface ChildLaunch {
	args: string[];
	model?: string;
	dispose?: () => void;
}

export type ChildArgsResolver = (request: {
	agent: AgentConfig;
	sessionId: string;
	label: string;
	dispatch?: DispatchDefaults;
}) => Promise<ChildLaunch>;

export type ClientFactory = (options: { args: string[]; cwd: string }) => RunClient;

export interface RegistryOptions {
	sessionDir: string;
	/** The working directory for runs that name none. */
	defaultCwd: string;
	/** Look up an agent definition by name, for a resume of a session this registry did not start. */
	findAgent?: (name: string, scope: AgentScope, cwd: string) => AgentConfig | undefined;
	/** Defaults to `createChildArgs(sessionDir)`. */
	childArgs?: ChildArgsResolver;
	/** Defaults to a `DelegateClient` launched with `command`. */
	createClient?: ClientFactory;
	/** The pi binary for the default client factory. Defaults to the resolved pi invocation. */
	command?: string;
	now?: () => number;
}

interface Entry {
	run: Run;
	agent: AgentConfig;
	agentScope: AgentScope;
	dispatch?: DispatchDefaults;
	/** The prompt a queued run sends once it launches. */
	pendingPrompt?: string;
	/** A launch is building the client, so the run holds a live slot without one. */
	reserved: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	unsubscribe?: () => void;
	toolArgs: Map<string, Record<string, unknown>>;
}

interface PendingWait {
	runs: Run[];
	resolve: (runs: Run[]) => void;
	reject: (err: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Build child flags from an agent definition: model, thinking, tools, and a system prompt file with the subagent protocol. */
export function createChildArgs(sessionDir: string): ChildArgsResolver {
	return async ({ agent, sessionId, label, dispatch }) => {
		const model = agent.model ?? dispatch?.model;
		const systemPrompt = [agent.systemPrompt.trim(), SUBAGENT_PROTOCOL].filter(Boolean).join("\n\n");
		const tmp = await writePromptToTempFile(agent.name, systemPrompt);
		const args = buildChildArgs({
			sessionDir,
			sessionId,
			label,
			model,
			thinkingLevel: agent.model ? undefined : dispatch?.thinkingLevel,
			tools: agent.tools,
			systemPromptFile: tmp.filePath,
		});
		return {
			args,
			model,
			dispose: () => fs.rmSync(tmp.dir, { recursive: true, force: true }),
		};
	};
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Report whether a run still has work in flight, so a `wait` keeps blocking on it. */
export function isActive(run: Pick<Run, "state">): boolean {
	return run.state === "queued" || run.state === "running";
}

/** Report whether a run has finished for good: done, failed, or stopped. A paused run still waits on answers. */
export function isFinished(run: Run): boolean {
	return run.state === "done" || run.state === "failed" || run.state === "stopped";
}

/** Report whether a run is queued, running, or paused, so the footer counts it and stop-all ends it. */
export function isLive(run: Run): boolean {
	return isActive(run) || run.state === "paused";
}

/** Report whether a run is settled as done or failed, so its child may be retired. */
function isIdleSettled(run: Run): boolean {
	return run.state === "done" || run.state === "failed";
}

/** Return the last assistant message in a list, if any. */
function lastAssistant(messages: Message[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") return msg;
	}
	return undefined;
}

/** Return an error's message, or the value as text. */
export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Report whether a queued run still needs a child of its own. */
function awaitsChild({ run, reserved }: Entry): boolean {
	return run.state === "queued" && !run.client && !reserved;
}

/** Track every delegate run of one pi session and route each settled result to exactly one consumer. */
export class RunRegistry {
	private readonly entries = new Map<string, Entry>();
	private readonly queue: string[] = [];
	private readonly waits = new Set<PendingWait>();
	private readonly listeners = new Set<(run: Run) => void>();
	private readonly sessionDir: string;
	private readonly defaultCwd: string;
	private readonly findAgent?: RegistryOptions["findAgent"];
	private readonly childArgs: ChildArgsResolver;
	private readonly createClient: ClientFactory;
	private readonly now: () => number;
	private closed = false;

	constructor(options: RegistryOptions) {
		this.sessionDir = options.sessionDir;
		this.defaultCwd = options.defaultCwd;
		this.findAgent = options.findAgent;
		this.childArgs = options.childArgs ?? createChildArgs(options.sessionDir);
		this.createClient =
			options.createClient ?? ((opts) => new DelegateClient({ ...opts, command: options.command }));
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Record a run and send its task. The run is `running` once the child accepted
	 * the prompt, or `queued` when `MAX_RUNNING` runs are already running. Rejects
	 * when `MAX_LIVE` children are alive and none is finished, counting the queued
	 * runs that will each need a child of their own.
	 */
	async start(spec: RunSpec): Promise<Run> {
		this.assertOpen();
		const id = newSessionId();
		const prompt = `Task: ${spec.task}`;
		const entry = this.createEntry(id, spec);
		const runNow = this.runningCount() < MAX_RUNNING;
		const hasSlot = runNow ? this.makeLiveSlot() : this.canQueueLaunch();
		if (!hasSlot) throw new Error(this.liveCapMessage());
		this.entries.set(id, entry);
		if (runNow) this.reserveLaunch(entry);
		else this.enqueue(entry, prompt);
		try {
			await writeMeta(this.sessionDir, id, {
				label: spec.label,
				agent: spec.agent.name,
				task: spec.task,
				cwd: spec.cwd,
				agentScope: spec.agentScope,
			});
		} catch (err) {
			entry.reserved = false;
			this.fail(entry, `Could not write the session meta file: ${errorText(err)}`);
			return entry.run;
		}
		if (runNow) await this.launch(entry, prompt);
		return entry.run;
	}

	/**
	 * Resolve once every run named is neither queued nor running, or when the
	 * timeout passes, with the runs in whatever state they hold. Omitted `ids`
	 * means every run queued or running now. A terminal run resolves at once. An
	 * aborted `signal`, including one aborted before the call, counts a waiter on
	 * each run and rejects, and the caller then calls `detach` for each id to
	 * release it.
	 */
	async wait(ids?: string[], timeoutMs?: number, signal?: AbortSignal): Promise<Run[]> {
		this.assertOpen();
		const runs = this.waitTargets(ids);
		if (!runs.some(isActive)) {
			for (const run of runs) run.delivered = true;
			return runs;
		}
		return new Promise((resolve, reject) => this.addWait({ runs, resolve, reject, signal }, timeoutMs));
	}

	/** Release one cancelled wait on a run and make it a background run, so its result is delivered later. */
	detach(id: string): void {
		const run = this.entries.get(id)?.run;
		if (!run) return;
		run.waiters = Math.max(0, run.waiters - 1);
		run.background = true;
		this.emit(run);
	}

	/** Deliver a message to a running child as a steer or a follow-up and return the child's disposition. */
	async send(id: string, text: string, mode: "steer" | "follow_up"): Promise<string> {
		const run = this.requireEntry(id).run;
		if (run.state !== "running") {
			throw new Error(`Subagent ${id} is ${run.state}, not running. Use resume to continue it.`);
		}
		const client = run.client;
		if (!client) throw new Error(`Subagent ${id} is still starting. Send again once it is running.`);
		return mode === "follow_up" ? client.followUp(text) : client.steer(text);
	}

	/**
	 * Stop a queued, running, or paused run's child and mark it stopped. Later
	 * events from that child are dropped. With `delivered` the stopped result
	 * counts as already reported, so no result message is posted for it. A
	 * finished run keeps its state, result, and delivery flag.
	 */
	async stop(id: string, options: { delivered?: boolean } = {}): Promise<void> {
		const entry = this.requireEntry(id);
		const { run } = entry;
		if (isFinished(run)) return;
		const client = run.client;
		this.unqueue(id);
		entry.reserved = false;
		this.dropClient(entry);
		run.state = "stopped";
		if (options.delivered) run.delivered = true;
		if (client) run.stderr = client.stderr;
		if (!this.closed) {
			this.resolveWaits(run);
			this.emit(run);
			this.pump();
		}
		await client?.stop().catch(() => {});
	}

	/**
	 * Continue a paused run with answers or a finished one with a follow-up task,
	 * in its live child or a child respawned on the session file. A session this
	 * registry did not start is rebuilt from its meta file. Rejects while a wait on
	 * the run is pending or the run is still queued or running, and when the run
	 * would queue without a live child while the live cap leaves none for it.
	 */
	async resume(id: string, input: ResumeInput): Promise<Run> {
		this.assertOpen();
		const existing = this.entries.get(id);
		const entry = existing ?? this.restore(id);
		const { run } = entry;
		this.assertResumable(run, input);
		const queues = this.runningCount() >= MAX_RUNNING;
		if (queues && !run.client && !this.canQueueLaunch()) throw new Error(this.liveCapMessage());
		if (!existing) this.entries.set(id, entry);
		if (input.dispatch) entry.dispatch = input.dispatch;
		const prompt = this.resumePrompt(run, input);
		if (queues) {
			this.enqueue(entry, prompt);
			return run;
		}
		if (!run.client && !this.makeLiveSlot()) throw new Error(this.liveCapMessage());
		await this.startTurn(entry, prompt);
		return run;
	}

	/** Record that a run's current result reached the orchestrator outside a `wait`, and emit the change. */
	markDelivered(id: string): void {
		const run = this.entries.get(id)?.run;
		if (!run || run.delivered) return;
		run.delivered = true;
		this.emit(run);
	}

	/** Report whether `close` has run. */
	isClosed(): boolean {
		return this.closed;
	}

	/** Return every run in the registry. */
	list(): Run[] {
		return [...this.entries.values()].map((entry) => entry.run);
	}

	/** Stop every queued, running, or paused run and retire every finished child. */
	async stopAll(): Promise<void> {
		const work: Promise<void>[] = [];
		for (const entry of [...this.entries.values()]) {
			const { run } = entry;
			if (isLive(run)) work.push(this.stop(run.id));
			else if (run.client) work.push(this.retire(entry));
		}
		await Promise.all(work);
	}

	/** Stop every child and resolve pending waits, then drop every later event, settle, and timer. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		const stops: Promise<void>[] = [];
		for (const entry of this.entries.values()) {
			const { run } = entry;
			const client = run.client;
			entry.reserved = false;
			this.dropClient(entry);
			if (isLive(run)) run.state = "stopped";
			if (client) stops.push(client.stop().catch(() => {}));
		}
		for (const wait of [...this.waits]) this.completeWait(wait);
		this.listeners.clear();
		await Promise.all(stops);
	}

	/** Subscribe to run changes. Returns the unsubscribe function. */
	on(_event: "change", fn: (run: Run) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("The subagent registry is closed");
	}

	private requireEntry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown subagent session "${id}"`);
		return entry;
	}

	private waitTargets(ids?: string[]): Run[] {
		return ids ? [...new Set(ids)].map((id) => this.requireEntry(id).run) : this.list().filter(isActive);
	}

	/** Register a pending wait, counting it on each run and arming its timeout and abort handlers. */
	private addWait(wait: PendingWait, timeoutMs?: number): void {
		const { signal } = wait;
		for (const run of wait.runs) run.waiters += 1;
		if (timeoutMs !== undefined) wait.timer = setTimeout(() => this.timeOutWait(wait), timeoutMs);
		if (signal) {
			wait.onAbort = () => {
				this.dropWait(wait);
				wait.reject(signal.reason);
			};
			signal.addEventListener("abort", wait.onAbort, { once: true });
		}
		this.waits.add(wait);
		if (signal?.aborted) wait.onAbort?.();
	}

	private assertResumable(run: Run, input: ResumeInput): void {
		const { id } = run;
		if (run.waiters > 0) throw new Error(`Subagent ${id} has a pending wait. Collect its result before resuming it.`);
		if (isActive(run)) throw new Error(`Subagent ${id} is ${run.state}. Use send to message a running subagent.`);
		const paused = run.state === "paused" || (run.paused?.length ?? 0) > 0;
		if (paused && input.answers === undefined) {
			const ids = (run.paused ?? []).map((q) => q.id).join(", ");
			throw new Error(`Subagent ${id} is paused on questions (${ids}). Resume it with answers, not a task.`);
		}
		if (!paused && input.task === undefined) {
			throw new Error(`Subagent ${id} has no open questions. Resume it with a task to send follow-up work.`);
		}
	}

	/** Build the prompt for a resume. A follow-up task also replaces the run's task and clears its recorded questions. */
	private resumePrompt(run: Run, input: ResumeInput): string {
		if (input.answers !== undefined) return formatAnswersMessage(run.paused ?? [], input.answers);
		run.task = input.task;
		if (input.label) run.label = input.label;
		this.updateMeta(run.id, { task: input.task, ...(input.label ? { label: input.label } : {}), questions: undefined });
		return `Follow-up task (continuing your previous work in this session): ${input.task}`;
	}

	private createEntry(id: string, spec: RunSpec): Entry {
		const now = this.now();
		return {
			run: {
				id,
				label: spec.label,
				agent: spec.agent.name,
				agentSource: spec.agent.source,
				task: spec.task,
				cwd: spec.cwd,
				model: spec.agent.model ?? spec.dispatch?.model,
				state: "queued",
				background: spec.background ?? false,
				notify: spec.notify ?? "wake",
				delivered: false,
				messages: [],
				turnStart: 0,
				usage: emptyUsage(),
				lastActivity: now,
				startedAt: now,
				stderr: "",
				waiters: 0,
			},
			agent: spec.agent,
			agentScope: spec.agentScope,
			dispatch: spec.dispatch,
			reserved: false,
			toolArgs: new Map(),
		};
	}

	/** Rebuild a settled run from its meta file. Throws when the meta file or the agent is missing. */
	private restore(id: string): Entry {
		const meta = readMeta(this.sessionDir, id);
		if (!meta) throw new Error(`Unknown subagent session "${id}". It may have expired or never existed.`);
		const agent = this.findAgent?.(meta.agent, meta.agentScope, meta.cwd ?? this.defaultCwd);
		if (!agent) throw new Error(`Unknown agent "${meta.agent}" for subagent session "${id}".`);
		const entry = this.createEntry(id, {
			label: labelOrPreview(meta.label, meta.task),
			agent,
			task: meta.task,
			cwd: meta.cwd,
			agentScope: meta.agentScope,
		});
		const questions: AskQuestion[] | undefined = meta.questions?.length ? meta.questions : undefined;
		entry.run.state = questions ? "paused" : "done";
		entry.run.paused = questions;
		entry.run.delivered = true;
		return entry;
	}

	private runningCount(): number {
		let count = 0;
		for (const { run } of this.entries.values()) if (run.state === "running") count += 1;
		return count;
	}

	private liveCount(): number {
		let count = 0;
		for (const entry of this.entries.values()) if (entry.run.client || entry.reserved) count += 1;
		return count;
	}

	/** Ensure a live slot exists, retiring the least recently active finished child when the cap is reached. */
	private makeLiveSlot(): boolean {
		if (this.liveCount() < MAX_LIVE) return true;
		let oldest: Entry | undefined;
		for (const entry of this.entries.values()) {
			const { run } = entry;
			if (!run.client || !isIdleSettled(run)) continue;
			if (!oldest || run.lastActivity < oldest.run.lastActivity) oldest = entry;
		}
		if (!oldest) return false;
		void this.retire(oldest);
		return true;
	}

	/** Report whether a run queued now could get a live child once dequeued, given the queued runs ahead of it that need one. */
	private canQueueLaunch(): boolean {
		const entries = [...this.entries.values()];
		const needed = 1 + entries.filter(awaitsChild).length;
		const retirable = entries.filter(({ run }) => run.client && isIdleSettled(run)).length;
		return this.liveCount() + needed <= MAX_LIVE + retirable;
	}

	private liveCapMessage(): string {
		return `${MAX_LIVE} subagent children are alive and none is finished. Wait for a run to finish or stop one, then start again.`;
	}

	/** Stop a run's child and drop it, keeping the run record and its state. */
	private async retire(entry: Entry): Promise<void> {
		const client = entry.run.client;
		if (!client) return;
		entry.run.stderr = client.stderr;
		this.dropClient(entry);
		this.emit(entry.run);
		await client.stop().catch(() => {});
	}

	/** Detach the run from its client so the client's later events and exit are ignored. */
	private dropClient(entry: Entry): void {
		entry.unsubscribe?.();
		entry.unsubscribe = undefined;
		entry.run.client = undefined;
		this.clearIdle(entry);
	}

	private enqueue(entry: Entry, prompt: string): void {
		entry.run.state = "queued";
		entry.run.delivered = false;
		entry.pendingPrompt = prompt;
		this.queue.push(entry.run.id);
		this.emit(entry.run);
	}

	private unqueue(id: string): void {
		const index = this.queue.indexOf(id);
		if (index !== -1) this.queue.splice(index, 1);
	}

	/** Start queued runs while a running slot is free, prompting a live child in place or launching one into a live slot. */
	private pump(): void {
		while (!this.closed && this.queue.length > 0 && this.runningCount() < MAX_RUNNING) {
			const next = this.entries.get(this.queue[0]);
			if (!next || next.run.state !== "queued") {
				this.queue.shift();
				continue;
			}
			const client = next.run.client;
			if (!client && !this.makeLiveSlot()) return;
			this.queue.shift();
			const prompt = next.pendingPrompt ?? `Task: ${next.run.task}`;
			next.pendingPrompt = undefined;
			void this.startTurn(next, prompt);
		}
	}

	/** Prompt the run's live child in place, or launch a child for it when it has none. The caller makes sure a live slot exists. */
	private startTurn(entry: Entry, prompt: string): Promise<void> {
		const { client } = entry.run;
		if (client) {
			this.beginTurn(entry);
			return this.sendPrompt(entry, client, prompt);
		}
		this.reserveLaunch(entry);
		return this.launch(entry, prompt);
	}

	/** Mark a turn as started: running, undelivered, and with its message mark at the current count. */
	private beginTurn(entry: Entry): void {
		const { run } = entry;
		run.state = "running";
		run.delivered = false;
		run.turnStart = run.messages.length;
		run.paused = undefined;
		run.errorMessage = undefined;
		run.stopReason = undefined;
		run.lastActivity = this.now();
		this.clearIdle(entry);
		this.emit(run);
	}

	/** Begin a turn on a run that has no client yet and hold a live slot for it. */
	private reserveLaunch(entry: Entry): void {
		entry.reserved = true;
		this.beginTurn(entry);
	}

	/** Start a child for a reserved run and send the prompt. Failures mark the run failed. */
	private async launch(entry: Entry, prompt: string): Promise<void> {
		const { run } = entry;
		let client: RunClient | undefined;
		try {
			client = await this.buildClient(entry);
			if (!client) return;
			await client.start();
			if (run.client !== client) return;
			await this.sendPrompt(entry, client, prompt);
		} catch (err) {
			this.failLaunch(entry, client, err);
		}
	}

	/** Create and attach the child for a reserved run. Returns undefined when the registry closed or the run was stopped while the flags were built. */
	private async buildClient(entry: Entry): Promise<RunClient | undefined> {
		const { run } = entry;
		const launch = await this.childArgs({ agent: entry.agent, sessionId: run.id, label: run.label, dispatch: entry.dispatch });
		if (this.closed || !entry.reserved) {
			launch.dispose?.();
			return undefined;
		}
		if (launch.model) run.model = launch.model;
		let client: RunClient;
		try {
			client = this.createClient({ args: launch.args, cwd: run.cwd ?? this.defaultCwd });
		} catch (err) {
			launch.dispose?.();
			throw err;
		}
		entry.reserved = false;
		this.attach(entry, client, launch.dispose);
		return client;
	}

	/** Mark a run failed after a launch error, unless a stop or a newer client already took it over. */
	private failLaunch(entry: Entry, client: RunClient | undefined, err: unknown): void {
		const { run } = entry;
		if (!client && !entry.reserved) return;
		entry.reserved = false;
		if (client && run.client !== client) return;
		this.fail(entry, [errorText(err), client?.stderr.trim()].filter(Boolean).join("\n"));
	}

	/** Send a prompt and settle at once when the child handles it without starting a run. */
	private async sendPrompt(entry: Entry, client: RunClient, prompt: string): Promise<void> {
		try {
			const disposition = await client.prompt(prompt);
			if (disposition === "handled" && entry.run.client === client && entry.run.state === "running") this.settle(entry);
		} catch (err) {
			if (entry.run.client === client) this.fail(entry, errorText(err));
		}
	}

	/** Subscribe to the client's events and exit, and run `dispose` once it exits. */
	private attach(entry: Entry, client: RunClient, dispose?: () => void): void {
		entry.run.client = client;
		entry.unsubscribe = client.onEvent((ev) => this.onEvent(entry, client, ev));
		void client.exited.then((exit) => {
			try {
				dispose?.();
			} catch {}
			this.onExit(entry, client, exit);
		});
	}

	private onEvent(entry: Entry, client: RunClient, event: JsonAgentSessionEvent): void {
		const { run } = entry;
		if (this.closed || run.client !== client) return;
		run.lastActivity = this.now();
		const ev = event as { type: string } & Record<string, any>;
		switch (ev.type) {
			case "agent_start":
				if (isIdleSettled(run) || run.state === "paused") {
					// No tool call awaits a turn the child started itself, so only the courier can deliver it.
					run.background = true;
					this.beginTurn(entry);
				}
				break;
			case "message_end":
				if (ev.message) {
					this.recordMessage(run, ev.message as Message);
					this.emit(run);
				}
				break;
			case "tool_execution_start":
				entry.toolArgs.set(ev.toolCallId, ev.args ?? {});
				break;
			case "tool_execution_end":
				run.lastTool = { name: ev.toolName, args: entry.toolArgs.get(ev.toolCallId) ?? {} };
				entry.toolArgs.delete(ev.toolCallId);
				this.emit(run);
				break;
			case "agent_settled":
				if (run.state === "running") this.settle(entry);
				break;
		}
	}

	/** Append a completed message and add an assistant message's usage to the run. */
	private recordMessage(run: Run, msg: Message): void {
		run.messages.push(msg);
		if (msg.role !== "assistant") return;
		run.usage.turns += 1;
		const usage = msg.usage;
		if (usage) {
			run.usage.input += usage.input || 0;
			run.usage.output += usage.output || 0;
			run.usage.cacheRead += usage.cacheRead || 0;
			run.usage.cacheWrite += usage.cacheWrite || 0;
			run.usage.cost += usage.cost?.total || 0;
			run.usage.contextTokens = usage.totalTokens || 0;
		}
		if (!run.model && msg.model) run.model = msg.model;
		if (msg.stopReason) run.stopReason = msg.stopReason;
	}

	private onExit(entry: Entry, client: RunClient, exit: DelegateExit): void {
		const { run } = entry;
		if (this.closed || run.client !== client) return;
		run.stderr = client.stderr;
		if (exit.code !== null) run.exitCode = exit.code;
		const wasRunning = run.state === "running";
		this.dropClient(entry);
		if (wasRunning) {
			run.state = "failed";
			run.exitCode ??= 1;
			run.errorMessage = client.stderr.trim() || `pi child exited (code ${exit.code}, signal ${exit.signal})`;
			this.finishTurn(entry);
			return;
		}
		this.emit(run);
		this.pump();
	}

	/** Decide the turn's outcome from the messages since the last prompt, then deliver it. */
	private settle(entry: Entry): void {
		const { run } = entry;
		const turn = run.messages.slice(run.turnStart);
		const last = lastAssistant(turn);
		let questions: AskQuestion[] | undefined;
		if (last && (last.stopReason === "error" || last.stopReason === "aborted")) {
			run.state = "failed";
			run.stopReason = last.stopReason;
			run.errorMessage = last.errorMessage || `Agent ${last.stopReason}`;
		} else {
			questions = detectPause(turn);
			run.state = questions ? "paused" : "done";
		}
		run.paused = questions;
		this.updateMeta(run.id, { questions });
		this.finishTurn(entry);
	}

	/** Mark a queued or running run failed and deliver it. A settled run is left alone. */
	private fail(entry: Entry, reason: string): void {
		const { run } = entry;
		if (this.closed || !isActive(run)) return;
		this.unqueue(run.id);
		run.state = "failed";
		run.errorMessage = reason;
		this.finishTurn(entry);
	}

	/** Resolve the waits that now have every run settled, emit the change, and launch queued runs. */
	private finishTurn(entry: Entry): void {
		this.scheduleIdle(entry);
		this.resolveWaits(entry.run);
		this.emit(entry.run);
		this.pump();
	}

	private resolveWaits(run: Run): void {
		for (const wait of [...this.waits]) {
			if (wait.runs.includes(run) && !wait.runs.some(isActive)) this.completeWait(wait);
		}
	}

	/** Resolve a wait with its runs as they stand, marking each settled one delivered. */
	private completeWait(wait: PendingWait): void {
		if (!this.waits.has(wait)) return;
		this.dropWait(wait);
		for (const run of wait.runs) {
			run.waiters = Math.max(0, run.waiters - 1);
			if (!isActive(run)) run.delivered = true;
		}
		wait.resolve(wait.runs);
	}

	/** Resolve a wait whose timeout passed and make each run still active a background run, so its later settle is posted. */
	private timeOutWait(wait: PendingWait): void {
		if (!this.waits.has(wait)) return;
		this.completeWait(wait);
		for (const run of wait.runs) {
			if (!isActive(run)) continue;
			run.background = true;
			this.emit(run);
		}
	}

	private dropWait(wait: PendingWait): void {
		this.waits.delete(wait);
		if (wait.timer) clearTimeout(wait.timer);
		if (wait.onAbort) wait.signal?.removeEventListener("abort", wait.onAbort);
	}

	/** Start the idle clock of a settled live child: ten minutes when done or failed, thirty when paused. */
	private scheduleIdle(entry: Entry): void {
		this.clearIdle(entry);
		const limit = this.idleLimit(entry.run);
		if (limit === undefined || !entry.run.client) return;
		const elapsed = this.now() - entry.run.lastActivity;
		entry.idleTimer = setTimeout(() => this.onIdle(entry), Math.max(0, limit - elapsed));
		entry.idleTimer.unref?.();
	}

	private idleLimit(run: Run): number | undefined {
		if (run.state === "paused") return PAUSED_IDLE_MS;
		if (run.state === "done" || run.state === "failed") return DONE_IDLE_MS;
		return undefined;
	}

	/** Retire the child once it has been idle for its full limit, else wait out the remainder. */
	private onIdle(entry: Entry): void {
		entry.idleTimer = undefined;
		const limit = this.idleLimit(entry.run);
		if (this.closed || limit === undefined || !entry.run.client) return;
		if (this.now() - entry.run.lastActivity < limit) {
			this.scheduleIdle(entry);
			return;
		}
		void this.retire(entry);
		this.pump();
	}

	private clearIdle(entry: Entry): void {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	/** Merge fields into a session's meta file in the background. A missing file is left alone. */
	private updateMeta(id: string, fields: { label?: string; task?: string; questions?: AskQuestion[] }): void {
		const meta = readMeta(this.sessionDir, id);
		if (!meta) return;
		writeMeta(this.sessionDir, id, { ...meta, ...fields }).catch(() => {});
	}

	private emit(run: Run): void {
		if (this.closed) return;
		for (const listener of [...this.listeners]) {
			try {
				listener(run);
			} catch {}
		}
	}
}
