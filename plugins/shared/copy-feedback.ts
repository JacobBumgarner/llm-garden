/**
 * The "copied" moment after a copy: copies text, remembers for how long the
 * panel should read "copied", and asks for a redraw when that time is up.
 */

import { copyToClipboard } from "./clipboard.ts";

/** How long a panel's status reads "copied" after a copy. */
export const COPIED_MS = 1500;

export interface CopyFeedbackOptions {
	requestRender: () => void;
	/** Where the clipboard fallback writes. Needed only when `copy` is not given. */
	terminal?: { write(data: string): void };
	/** Copy text to the clipboard. Defaults to `copyToClipboard` against `terminal`. */
	copy?: (text: string) => void;
	/** Clock in milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

export class CopyFeedback {
	private readonly requestRender: () => void;
	private readonly doCopy: (text: string) => void;
	private readonly now: () => number;
	private until = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: CopyFeedbackOptions) {
		this.requestRender = options.requestRender;
		const terminal = options.terminal;
		this.doCopy =
			options.copy ??
			((text) => {
				if (terminal) void copyToClipboard(text, terminal);
			});
		this.now = options.now ?? Date.now;
	}

	/** Copy `text` and start the "copied" moment. An empty string does nothing. */
	copy(text: string): void {
		if (text === "") return;
		this.doCopy(text);
		this.until = this.now() + COPIED_MS;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(this.requestRender, COPIED_MS);
		this.timer.unref?.();
	}

	/** Whether the "copied" moment is still on. */
	active(): boolean {
		return this.now() < this.until;
	}

	/** Cancel the pending redraw. */
	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
