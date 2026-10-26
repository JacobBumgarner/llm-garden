/**
 * Activity feed: publishes a delegate's progress as `subagent:activity` events
 * on `pi.events`, keyed by the run and by the orchestrator's tool call that
 * owns it, so another extension (the focus-mode actions panel) can nest the
 * delegate's text, thinking, and tool calls under that call and keep the
 * call's row current without importing this plugin. One event goes out per
 * message the delegate completes, carrying the message, and one per change of
 * state, usage, or last tool, carrying none. User messages (the task prompt
 * and answers) are not published. Imports types only from pi packages.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { Run, RunState, UsageStats } from "./types.ts";

export const ACTIVITY_EVENT = "subagent:activity";

/** The payload of one `subagent:activity` event. */
export interface ActivityEvent {
	runId: string;
	agent: string;
	label: string;
	/** The orchestrator's tool call the run belongs to, when one is recorded. */
	callId?: string;
	state: RunState;
	usage: UsageStats;
	lastTool?: { name: string; args: Record<string, unknown> };
	/** The completed child message: an assistant message or a tool result. Absent for a bare progress update. */
	message?: Message;
}

/** The registry surface the feed reads. A `RunRegistry` satisfies it. */
export interface ActivityRegistry {
	on(event: "change", fn: (run: Run) => void): () => void;
}

/** The event bus surface the feed writes. `pi.events` satisfies it. */
export interface ActivityBus {
	emit(event: string, data: unknown): void;
}

/** What was last published for a run, to tell a real change from a repeated emit. */
interface Cursor {
	messages: number;
	progress: string;
}

/** A string that changes whenever the run's row in a panel would. */
function progressKey(run: Run): string {
	const { input, output, cost, turns } = run.usage;
	return [run.state, turns, input, output, cost, run.lastTool?.name ?? ""].join("|");
}

function snapshot(run: Run, message?: Message): ActivityEvent {
	return {
		runId: run.id,
		agent: run.agent,
		label: run.label,
		callId: run.callId,
		state: run.state,
		usage: { ...run.usage },
		lastTool: run.lastTool,
		...(message ? { message } : {}),
	};
}

/**
 * Watch the registry. For each run change, emit one event per new non-user
 * message, in order, and a bare progress event when the state, usage, or last
 * tool changed without a new message. A run's message list only grows, so the
 * count already emitted is the cursor. Returns the dispose function.
 */
export function createActivityFeed(registry: ActivityRegistry, bus: ActivityBus): () => void {
	const cursors = new Map<string, Cursor>();
	const unsubscribe = registry.on("change", (run) => {
		const cursor = cursors.get(run.id) ?? { messages: 0, progress: "" };
		const progress = progressKey(run);
		const fresh = run.messages.slice(cursor.messages).filter((message) => message.role !== "user");
		cursors.set(run.id, { messages: run.messages.length, progress });
		for (const message of fresh) bus.emit(ACTIVITY_EVENT, snapshot(run, message));
		if (fresh.length === 0 && progress !== cursor.progress) bus.emit(ACTIVITY_EVENT, snapshot(run));
	});
	return () => {
		unsubscribe();
		cursors.clear();
	};
}
