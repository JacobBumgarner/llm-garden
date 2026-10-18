/**
 * Detect a mouse press outside the aside panel from the raw terminal input.
 * pi-tui hands overlays only the mouse events inside their own bounds, and its
 * own input listener consumes mouse sequences before any other listener runs,
 * so the panel reads `process.stdin` itself for SGR press sequences and
 * compares them with the overlay's last drawn rectangle.
 */

/** A rectangle in terminal cells, as `OverlayHandle.getBounds()` reports it. */
export interface Bounds {
	row: number;
	col: number;
	width: number;
	height: number;
}

const SGR_PRESS = /\x1b\[<(\d+);(\d+);(\d+)M/g;

/** Every left press in a chunk of terminal input as zero-based cells. Releases, drags, wheel, and other buttons are skipped. */
export function parsePresses(data: string): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	for (const match of data.matchAll(SGR_PRESS)) {
		const button = Number.parseInt(match[1], 10);
		if ((button & 0b11100011) !== 0) continue;
		out.push({ x: Number.parseInt(match[2], 10) - 1, y: Number.parseInt(match[3], 10) - 1 });
	}
	return out;
}

/** True when the cell is outside the rectangle. */
export function isOutside(cell: { x: number; y: number }, bounds: Bounds): boolean {
	return cell.x < bounds.col || cell.x >= bounds.col + bounds.width || cell.y < bounds.row || cell.y >= bounds.row + bounds.height;
}

/**
 * Build a `data` handler that calls `onOutside` once per chunk holding a left press outside `bounds()`.
 * A missing rectangle, which is how a hidden overlay reports itself, is ignored.
 */
export function outsideClickListener(bounds: () => Bounds | undefined, onOutside: () => void): (data: string | Buffer) => void {
	return (data) => {
		const presses = parsePresses(typeof data === "string" ? data : data.toString("utf8"));
		if (presses.length === 0) return;
		const rect = bounds();
		if (rect && presses.some((cell) => isOutside(cell, rect))) onOutside();
	};
}

/** Watch `process.stdin` for a left press outside `bounds()` and return a function that stops watching. */
export function watchOutsideClicks(bounds: () => Bounds | undefined, onOutside: () => void): () => void {
	const listener = outsideClickListener(bounds, onOutside);
	process.stdin.on("data", listener);
	return () => void process.stdin.off("data", listener);
}
