/**
 * Keep inline images from showing through an overlay. pi-tui leaves an image line untouched when it
 * composites an overlay over it, and terminals paint Kitty graphics above text, so a panel opened over
 * a tool result with an image sits under the picture. While a shield is held on a TUI, its overlay
 * compositing is wrapped: an image anchored on a row an overlay covers is composited as if the row
 * were blank, and an image anchored elsewhere whose rows reach into an overlay is dropped from the
 * frame. Either way the anchor line changes, which makes pi-tui delete the placement and redraw the
 * rows as text. The image returns on the first frame after the last shield on that TUI is released.
 */

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

/** A rectangle in viewport rows, as pi-tui keeps for each drawn overlay. */
interface Rect {
	row: number;
	height: number;
}

/** The private pi-tui members the shield wraps. They are not in the public typings. */
interface Compositing {
	compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[];
	compositeLineAt(baseLine: string, overlayLine: string, startCol: number, overlayWidth: number, totalWidth: number): string;
	renderedOverlayLayouts: Rect[];
}

interface Installed {
	holders: number;
	restore(): void;
}

const installed = new WeakMap<object, Installed>();

export function isImageLine(line: string): boolean {
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * The rows an image line covers, relative to its own index: Kitty draws down from the anchor,
 * iTerm2 moves up `n` rows first and draws down from there. Unknown layouts count as one row.
 */
export function imageSpan(line: string): { from: number; to: number } {
	const kitty = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (kitty !== undefined) {
		const rows = Number.parseInt(/(?:^|,)r=(\d+)(?:,|$)/.exec(kitty)?.[1] ?? "1", 10);
		return { from: 0, to: Math.max(rows, 1) };
	}
	const up = /^\x1b\[(\d+)A/.exec(line)?.[1];
	const rows = up === undefined ? 1 : Number.parseInt(up, 10) + 1;
	return { from: 1 - rows, to: 1 };
}

function covers(rects: Rect[], from: number, to: number): boolean {
	return rects.some((rect) => from < rect.row + rect.height && to > rect.row);
}

/** Blank every image line in `lines` whose rows reach into one of `rects`. Rows are viewport-relative; `lines` may be taller. */
export function dropCoveredImages(lines: string[], rects: Rect[], termHeight: number): string[] {
	if (rects.length === 0) return lines;
	const viewportStart = Math.max(0, lines.length - termHeight);
	return lines.map((line, index) => {
		if (!isImageLine(line)) return line;
		const span = imageSpan(line);
		const row = index - viewportStart;
		return covers(rects, row + span.from, row + span.to) ? "" : line;
	});
}

/**
 * Hold a shield on `tui` and return the release. The wrap is installed on the first hold and removed
 * on the last release. A TUI without the compositing members (a test double) is left alone.
 */
export function shieldImages(tui: object): () => void {
	const target = tui as unknown as Compositing;
	if (typeof target.compositeOverlays !== "function" || typeof target.compositeLineAt !== "function") return () => {};
	let entry = installed.get(tui);
	if (!entry) {
		const compositeOverlays = target.compositeOverlays;
		const compositeLineAt = target.compositeLineAt;
		target.compositeOverlays = function (this: Compositing, lines, termWidth, termHeight) {
			const result = compositeOverlays.call(this, lines, termWidth, termHeight);
			return dropCoveredImages(result, this.renderedOverlayLayouts ?? [], termHeight);
		};
		target.compositeLineAt = function (this: Compositing, baseLine, overlayLine, startCol, overlayWidth, totalWidth) {
			return compositeLineAt.call(this, isImageLine(baseLine) ? "" : baseLine, overlayLine, startCol, overlayWidth, totalWidth);
		};
		entry = {
			holders: 0,
			restore: () => {
				target.compositeOverlays = compositeOverlays;
				target.compositeLineAt = compositeLineAt;
			},
		};
		installed.set(tui, entry);
	}
	entry.holders++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = installed.get(tui);
		if (!current) return;
		current.holders--;
		if (current.holders > 0) return;
		current.restore();
		installed.delete(tui);
	};
}
