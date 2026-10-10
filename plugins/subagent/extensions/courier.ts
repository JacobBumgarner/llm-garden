/**
 * Result courier: posts background results that no `wait` or tool call collected into the
 * orchestrator's session. Runs that settle within one second of each other go
 * out as one `subagent-result` message, which wakes an idle orchestrator unless
 * every run in it was started quiet. While the orchestrator is mid-turn the
 * courier holds results and posts them when the turn ends. Imports types only from pi packages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDeliverySection, snapshotRun } from "./format.ts";
import { isActive } from "./registry.ts";
import type { Run, RunState, UsageStats } from "./types.ts";

export const RESULT_MESSAGE_TYPE = "subagent-result";
export const COALESCE_MS = 1000;
export const NOTICE_HEADER = "[subagent tool] Background run finished. This is an automated notice, not a message from the user.";
const NOTICE_HEADER_PLURAL = "[subagent tool] Background runs finished. This is an automated notice, not a message from the user.";

/** The details of a posted result message, one entry per run in the order of the sections. */
export interface ResultMessageDetails {
	runs: { sessionId: string; label: string; agent: string; state: RunState; usage: UsageStats; model?: string }[];
}

/** The registry surface the courier reads. A `RunRegistry` satisfies it. */
export interface CourierRegistry {
	on(event: "change", fn: (run: Run) => void): () => void;
	markDelivered(id: string): void;
	isClosed(): boolean;
}

/** How the courier learns whether the orchestrator is mid-turn. */
export interface CourierOptions {
	/** Report whether the orchestrator is between turns. */
	isIdle: () => boolean;
	/** Subscribe to the end of each orchestrator turn. Returns the unsubscribe function. */
	onTurnEnd: (fn: () => void) => () => void;
}

export type MessageSender = Pick<ExtensionAPI, "sendMessage">;

/**
 * Report whether a run holds a result the courier must post: settled, background,
 * unclaimed by a wait, and not yet delivered. A foreground run becomes background
 * once its wait is detached or times out, or its child starts a turn on its own.
 * Posting a foreground run directly would duplicate the result its tool call
 * returns, and a multi-task start settles its runs at different times.
 */
export function needsDelivery(run: Run): boolean {
	return run.background && !isActive(run) && !run.delivered && run.waiters === 0;
}

/** Remove the notice header and the blank line after it from a posted message's text. */
export function stripNoticeHeader(text: string): string {
	for (const header of [NOTICE_HEADER, NOTICE_HEADER_PLURAL]) {
		if (text.startsWith(`${header}\n\n`)) return text.slice(header.length + 2);
	}
	return text;
}

/** Build the message content and details for a batch of runs, opened by the automated-notice header. */
export function buildResultMessage(runs: Run[]): { content: string; details: ResultMessageDetails } {
	const header = runs.length > 1 ? NOTICE_HEADER_PLURAL : NOTICE_HEADER;
	const sections = runs.map((run) => formatDeliverySection(snapshotRun(run, true))).join("\n\n---\n\n");
	const content = `${header}\n\n${sections}`;
	const details: ResultMessageDetails = {
		runs: runs.map((run) => ({
			sessionId: run.id,
			label: run.label,
			agent: run.agent,
			state: run.state,
			usage: { ...run.usage },
			model: run.model,
		})),
	};
	return { content, details };
}

/**
 * Watch the registry and post each undelivered background result once. While
 * the orchestrator is idle, the first eligible run of a batch arms a one-second
 * timer, and when it fires every run still eligible goes out in one message and
 * is marked delivered. While it is mid-turn nothing is armed, and the end of the
 * turn arms the timer for the runs no wait collected in the meantime. A timer
 * that fires after a turn has begun posts nothing and leaves the batch for the
 * next turn end. Without
 * `options` the timer always arms at once. Returns the dispose function, which
 * drops the pending batch and unsubscribes from the registry and the turn end.
 */
export function createCourier(registry: CourierRegistry, pi: MessageSender, options?: CourierOptions): () => void {
	const pending = new Map<string, Run>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const post = (runs: Run[]) => {
		const { content, details } = buildResultMessage(runs);
		const wake = runs.some((run) => run.notify === "wake");
		try {
			pi.sendMessage(
				{ customType: RESULT_MESSAGE_TYPE, content, display: true, details },
				wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" },
			);
		} catch {
			// A replaced session leaves a stale `pi` that throws, and its runs are gone.
			return;
		}
		for (const run of runs) registry.markDelivered(run.id);
	};

	const idle = () => options?.isIdle() ?? true;

	const flush = () => {
		timer = undefined;
		// A turn may have begun since the timer was armed. Posting into it would queue the
		// follow-up behind a model that can still collect the result with wait.
		if (!idle()) return;
		const runs = [...pending.values()].filter(needsDelivery);
		pending.clear();
		if (runs.length > 0 && !registry.isClosed()) post(runs);
	};

	const arm = () => {
		timer ??= setTimeout(flush, COALESCE_MS);
	};

	const unsubscribe = registry.on("change", (run) => {
		if (!needsDelivery(run)) return;
		pending.set(run.id, run);
		if (idle()) arm();
	});

	const unsubscribeTurnEnd = options?.onTurnEnd(() => {
		if (pending.size > 0) arm();
	});

	return () => {
		unsubscribe();
		unsubscribeTurnEnd?.();
		clearTimeout(timer);
		timer = undefined;
		pending.clear();
	};
}
