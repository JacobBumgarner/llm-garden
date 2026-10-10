/**
 * Tracker of tool calls that are blocked waiting on delegates. Each blocked
 * call registers a detach callback so one event can release them all.
 */

export type DetachReason = "abort" | "user-input";

export interface BlockedCalls {
	/** Register a blocked call and return the function that unregisters it. Calling it more than once is harmless. */
	enter(onDetach: (reason: DetachReason) => void): () => void;
	/** Invoke every registered callback with `reason`, unregister them, and return how many ran. */
	detachAll(reason: DetachReason): number;
	/** Count the registered calls. */
	size(): number;
}

type Entry = (reason: DetachReason) => void;

/** Create an empty tracker. */
export function createBlockedCalls(): BlockedCalls {
	const entries = new Set<Entry>();
	return {
		enter(onDetach) {
			const entry: Entry = (reason) => onDetach(reason);
			entries.add(entry);
			return () => {
				entries.delete(entry);
			};
		},
		detachAll(reason) {
			const detaching = [...entries];
			entries.clear();
			for (const entry of detaching) entry(reason);
			return detaching.length;
		},
		size: () => entries.size,
	};
}

/** Return true for a message the user typed while the agent was streaming, which steers the turn. */
export function shouldDetachOnInput(ev: { source: string; streamingBehavior?: string }): boolean {
	return ev.source === "interactive" && ev.streamingBehavior === "steer";
}
