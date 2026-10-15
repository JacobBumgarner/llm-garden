/**
 * Double-press timing for the Esc key. Pure, so the timing runs without a
 * terminal or a clock.
 */

/** Milliseconds within which a second Esc press pairs with the first. */
export const ESCAPE_WINDOW_MS = 1500;

/**
 * Create a press counter. `press` returns true when the press lands within
 * `windowMs` of the previous unpaired press, and the pair then resets so the
 * next press starts a fresh one.
 */
export function createEscapeTimer(windowMs: number, now: () => number): { press(): boolean } {
	let last: number | undefined;
	return {
		press() {
			const at = now();
			if (last !== undefined && at - last <= windowMs) {
				last = undefined;
				return true;
			}
			last = at;
			return false;
		},
	};
}
