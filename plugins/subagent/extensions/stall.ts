/**
 * Stall detection for delegate runs: the thresholds, the request-age readers
 * the registry and the formatters share, and the prompt a restarted child
 * receives. A run is stalled when its current model request has been in flight
 * for `STALL_MS`. Imports types only.
 */

import type { Run } from "./types.ts";

/** A model request this old marks its run stalled. Normal requests settle in seconds. */
export const STALL_MS = 2 * 60 * 1000;
/** A model request this old gets its child restarted. */
export const AUTO_RESTART_MS = 5 * 60 * 1000;
/** Automatic restarts in one turn before the run fails instead. */
export const MAX_AUTO_RESTARTS = 2;

/** Why a child is replaced: the user asked, or the watchdog saw a stalled request. */
export type RestartReason = "user" | "stall";

/** Return how long the run's current model request has been in flight, or undefined when none is. */
export function requestAge(run: Pick<Run, "state" | "modelSince">, now: number): number | undefined {
	if (run.state !== "running" || run.modelSince === undefined) return undefined;
	return Math.max(0, now - run.modelSince);
}

/** Return the age of a run's model request once it has passed `STALL_MS`, or undefined when the run is not stalled. */
export function stallAge(run: Pick<Run, "state" | "modelSince">, now: number): number | undefined {
	const age = requestAge(run, now);
	return age !== undefined && age >= STALL_MS ? age : undefined;
}

/** The prompt a restarted child receives, naming why its predecessor was replaced. */
export function restartPrompt(reason: RestartReason): string {
	const cause =
		reason === "stall"
			? `your model request stalled for over ${Math.round(AUTO_RESTART_MS / 60_000)} minutes`
			: "the user asked for a restart";
	return [
		`Your session was restarted because ${cause}. Your transcript so far is intact.`,
		"Any tool call that was in flight when the restart happened may not have completed, so check its effects before relying on them.",
		"Continue the task from where you left off.",
	].join(" ");
}
