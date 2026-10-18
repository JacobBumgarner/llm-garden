/**
 * Drag-to-select for text panels. The pure helpers describe a selection over
 * a list of unstyled lines. `TextSelection` holds the anchor, focus, and
 * settled state and turns mouse events into selection changes. Hosts map
 * pointer coordinates to cells, copy the text, and show their own feedback.
 */

import {
	sliceByColumn,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** A position in a list of lines: line index, character column into that line. */
export interface Cell {
	line: number;
	col: number;
}

/** A drag from the pressed cell to the one under the pointer. `settled` once released. */
export interface Selection {
	anchor: Cell;
	focus: Cell;
	settled: boolean;
}

/** Whether `a` comes strictly before `b` in reading order. */
export function before(a: Cell, b: Cell): boolean {
	return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** The selection's cells in reading order. */
export function ordered(selection: { anchor: Cell; focus: Cell }): [Cell, Cell] {
	return before(selection.focus, selection.anchor) ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
}

/** The text a selection covers: the first line from its start column, whole lines between, the last through its end column. */
export function selectedText(lines: string[], selection: { anchor: Cell; focus: Cell }): string {
	const [start, end] = ordered(selection);
	const out: string[] = [];
	for (let line = start.line; line <= end.line && line < lines.length; line++) {
		const from = line === start.line ? start.col : 0;
		const to = line === end.line ? end.col + 1 : Number.POSITIVE_INFINITY;
		out.push(sliceByColumn(lines[line]!, from, to - from).trimEnd());
	}
	return out.join("\n");
}

/** Paint the selected span of line `line` with `inverse`, padding `text` to `width` first so a selection past its end still shows. */
export function highlightSelection(
	text: string,
	line: number,
	width: number,
	selection: { anchor: Cell; focus: Cell } | undefined,
	inverse: (text: string) => string,
): string {
	if (!selection) return text;
	const [start, end] = ordered(selection);
	if (line < start.line || line > end.line) return text;
	const from = line === start.line ? start.col : 0;
	const to = Math.min(width - 1, line === end.line ? end.col : Number.POSITIVE_INFINITY);
	if (from > to) return text;
	const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
	const span = stripTerminalSequences(sliceByColumn(padded, from, to - from + 1));
	return sliceByColumn(padded, 0, from) + inverse(span) + sliceByColumn(padded, to + 1, width - to - 1);
}

/** Maps a component-local point to a cell. With `clampEdges` a point outside snaps to the nearest cell, else it returns undefined. */
export type CellAt = (x: number, y: number, clampEdges: boolean) => Cell | undefined;

/** What `TextSelection.drag` decided: the mouse result to return, and the text to copy when a drag just ended. */
export interface DragOutcome {
	result: TuiMouseEventResult;
	/** Set on a release that moved. The host copies it and shows its feedback. */
	copy?: string;
}

/** The selection state of one panel. */
export class TextSelection {
	/** The current selection, for `highlightSelection`. */
	current: Selection | undefined;

	/** Whether a press is held and the selection is still growing. */
	get dragging(): boolean {
		return this.current !== undefined && !this.current.settled;
	}

	/** Drop the selection. */
	clear(): void {
		this.current = undefined;
	}

	/** Start a selection at `cell`, dropping any earlier one. With no cell the selection stays empty. */
	press(cell: Cell | undefined): void {
		this.current = cell ? { anchor: cell, focus: cell, settled: false } : undefined;
	}

	/**
	 * Handle an event while `dragging`. A drag or move grows the selection to the cell under the pointer.
	 * A release settles it and reports the text to copy, or drops it when it never moved.
	 */
	drag(event: TuiMouseEvent, cellAt: CellAt, lines: string[]): DragOutcome {
		const selection = this.current!;
		if (event.type === "drag" || event.type === "move") {
			const cell = cellAt(event.x, event.y, true);
			if (cell) this.current = { ...selection, focus: cell };
			return { result: { handled: true, render: true } };
		}
		if (event.type === "release") {
			const moved = before(selection.anchor, selection.focus) || before(selection.focus, selection.anchor);
			this.current = moved ? { ...selection, settled: true } : undefined;
			return { result: { handled: true, render: true }, copy: moved ? selectedText(lines, selection) : undefined };
		}
		return { result: { handled: true } };
	}

	/** Select all of line `line` of `lines`, settled. Returns the text to copy. */
	selectLine(lines: string[], line: number): string {
		const text = lines[line] ?? "";
		const end = Math.max(0, visibleWidth(text) - 1);
		this.current = { anchor: { line, col: 0 }, focus: { line, col: end }, settled: true };
		return text.trimEnd();
	}
}
