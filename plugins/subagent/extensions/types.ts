/**
 * Record types shared by the subagent modules, including the run record the
 * registry keeps per delegate. Imports types only.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AskQuestion } from "../../ask/extensions/types.ts";
import type { AgentScope } from "./agents.ts";
import type { DelegateClient } from "./rpc.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** What a resume needs to know about the run it continues. Stored beside the session file. */
export interface SessionMeta {
	/** The run's title. Optional, since a meta file may lack it, and a restore then previews the task. */
	label?: string;
	agent: string;
	task: string;
	cwd?: string;
	agentScope: AgentScope;
	/** Questions recorded at the last pause, so answers can be matched to ids. Cleared when the run completes. */
	questions?: AskQuestion[];
}

/** The outcome of one subagent process, complete or in flight. */
export interface SingleResult {
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
	sessionId: string;
	/** Questions the subagent paused on. The run must be resumed with answers. */
	paused?: AskQuestion[];
}

export type RunState = "queued" | "running" | "paused" | "done" | "failed" | "stopped";

/** The surface of a Delegate client the registry drives. A `DelegateClient` satisfies it. */
export type RunClient = Pick<
	DelegateClient,
	"start" | "prompt" | "steer" | "followUp" | "stop" | "onEvent" | "exited" | "stderr"
>;

/** One delegate started in this pi session, from its first prompt until the session ends. */
export interface Run {
	/** The session id, shared with the session and meta files. */
	id: string;
	/** The parent-written title, updated by a resume that names one. */
	label: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	/** The task as last stated, updated by a follow-up resume. */
	task: string;
	cwd?: string;
	model?: string;
	state: RunState;
	background: boolean;
	notify: "wake" | "quiet";
	/**
	 * Whether the current result reached the orchestrator through a `wait`. A
	 * terminal run that is undelivered with `waiters > 0` belongs to that wait.
	 */
	delivered: boolean;
	/** Every message the child completed while this registry observed it. */
	messages: Message[];
	/** The message count when the last prompt was sent. The current turn is `messages.slice(turnStart)`. */
	turnStart: number;
	usage: UsageStats;
	lastActivity: number;
	startedAt: number;
	/** The last tool the child finished running. */
	lastTool?: { name: string; args: Record<string, unknown> };
	paused?: AskQuestion[];
	stopReason?: string;
	errorMessage?: string;
	exitCode?: number;
	/** The child's stderr tail, kept after the client is gone. */
	stderr: string;
	/** Absent while queued and once the child is retired or has exited. */
	client?: RunClient;
	/** Pending `wait` calls that include this run. */
	waiters: number;
}

/** A serializable view of a run for tool result details and rendering. `messages` holds the current turn, or nothing for a summary. */
export interface RunSnapshot extends SingleResult {
	label: string;
	state: RunState;
	background: boolean;
	lastTool?: { name: string; args: Record<string, unknown> };
}

/** A text block or tool call extracted from an assistant message for display. */
export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

/** A run that stopped on a blocked `ask`. */
export interface PausedRun {
	agent: string;
	sessionId: string;
	questions: AskQuestion[];
	/** The subagent's last text before it paused, if any. */
	lastOutput: string;
}
