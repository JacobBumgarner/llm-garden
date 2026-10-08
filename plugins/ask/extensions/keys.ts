/**
 * Key names the form state understands, and the chords that produce the two
 * that are not plain navigation. No pi import, so the state tests can load it.
 */

export type KeyName =
	| "up"
	| "down"
	| "left"
	| "right"
	| "tab"
	| "shift+tab"
	| "space"
	| "enter"
	| "escape"
	| "pageUp"
	| "pageDown"
	| "shift+up"
	| "shift+down"
	| "shift+left"
	| "shift+right"
	| "note"
	| "clarify"
	| "cancel"
	| "printable";

/** pi KeyId strings for the chords. Swap here if pi claims one. */
export const CHORDS = {
	note: "ctrl+n",
	clarify: "ctrl+k",
	cancel: "ctrl+c",
} as const;

/** Plain-navigation keys mapped to the pi KeyId that produces them, modified keys before their plain ones. */
export const NAV_KEYS: Record<Exclude<KeyName, "note" | "clarify" | "cancel" | "printable">, string> = {
	"shift+up": "shift+up",
	"shift+down": "shift+down",
	"shift+left": "shift+left",
	"shift+right": "shift+right",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	tab: "tab",
	"shift+tab": "shift+tab",
	space: "space",
	enter: "enter",
	escape: "escape",
	pageUp: "pageUp",
	pageDown: "pageDown",
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Strip bracketed-paste markers, leaving the pasted text. Identity otherwise. */
export function unwrapPaste(data: string): string {
	if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
		return data.slice(PASTE_START.length, data.length - PASTE_END.length);
	}
	return data;
}

/** True when a raw input chunk is text to type: non-empty, no control characters once unwrapped. */
export function isPrintable(data: string): boolean {
	const text = unwrapPaste(data);
	// eslint-disable-next-line no-control-regex
	return text.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}
