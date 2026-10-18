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
import { clamp } from "./clamp.ts";

const WORD_JOINERS = new Set(["/", "-"]);
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

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

/**
 * Paint the selected span of line `line` with `inverse`, padding `text` to `width` first so a selection past its end still shows.
 * Selection columns are text columns, so `pan` is subtracted to get the columns of `text`.
 */
export function highlightSelection(
	text: string,
	line: number,
	width: number,
	selection: { anchor: Cell; focus: Cell } | undefined,
	inverse: (text: string) => string,
	pan = 0,
): string {
	if (!selection) return text;
	const [start, end] = ordered(selection);
	if (line < start.line || line > end.line) return text;
	const from = Math.max(0, (line === start.line ? start.col : 0) - pan);
	const to = Math.min(width - 1, (line === end.line ? end.col : Number.POSITIVE_INFINITY) - pan);
	if (from > to) return text;
	const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
	const span = stripTerminalSequences(sliceByColumn(padded, from, to - from + 1));
	return sliceByColumn(padded, 0, from) + inverse(span) + sliceByColumn(padded, to + 1, width - to - 1);
}

/** The text area as last drawn: unstyled lines, its component-local origin and size, and the first visible line and column. */
export interface PaintedText {
	lines: string[];
	x: number;
	y: number;
	width: number;
	height: number;
	top: number;
	pan: number;
}

/**
 * Map a component-local point to a cell of `painted`. A point outside the area, or on a row below the last
 * line, gives undefined, unless `clampEdges` snaps it to the nearest cell.
 */
export function cellAt(painted: PaintedText, x: number, y: number, clampEdges: boolean): Cell | undefined {
	const { lines, top, pan, width, height } = painted;
	if (lines.length === 0) return undefined;
	const bodyX = x - painted.x;
	const bodyY = y - painted.y;
	const inside = bodyX >= 0 && bodyX < width && bodyY >= 0 && bodyY < height && top + bodyY < lines.length;
	if (!clampEdges && !inside) return undefined;
	const line = clamp(top + clamp(bodyY, 0, height - 1), 0, lines.length - 1);
	return { line, col: pan + clamp(bodyX, 0, width - 1) };
}

/** Maps a component-local point to a cell. With `clampEdges` a point outside snaps to the nearest cell, else it returns undefined. */
export type CellAt = (x: number, y: number, clampEdges: boolean) => Cell | undefined;

/** What `TextSelection.drag` decided: the mouse result to return, and the text to copy when a drag just ended. */
export interface DragOutcome {
	result: TuiMouseEventResult;
	/** Set on a release that moved. The host copies it and shows its feedback. */
	copy?: string;
}

interface WordSegment {
	start: number;
	end: number;
	selectable: boolean;
	joiner: boolean;
}

function canJoin(left: WordSegment, right: WordSegment): boolean {
	return left.selectable && right.selectable && (left.joiner || right.joiner);
}

function joinsNeighbour(segments: WordSegment[], index: number): boolean {
	return (index > 0 && canJoin(segments[index - 1]!, segments[index]!)) || (index < segments.length - 1 && canJoin(segments[index]!, segments[index + 1]!));
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

	/**
	 * Select the word under `cell`, settled, and return its text. Paths and kebab-case tokens stay whole:
	 * a `/` or `-` joins the word-like segments beside it. A cell that is not on a word selects nothing and returns "".
	 */
	selectWord(lines: string[], cell: Cell): string {
		const line = lines[cell.line] ?? "";
		const segments: WordSegment[] = [];
		let start = 0;
		for (const part of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(part.segment);
			const joiner = WORD_JOINERS.has(part.segment);
			segments.push({ start, end, selectable: part.isWordLike === true || joiner, joiner });
			start = end;
		}
		const hit = segments.findIndex((s) => cell.col >= s.start && cell.col < s.end);
		if (hit < 0 || !segments[hit]!.selectable || (segments[hit]!.joiner && !joinsNeighbour(segments, hit))) {
			this.current = undefined;
			return "";
		}
		let from = hit;
		let to = hit;
		while (from > 0 && canJoin(segments[from - 1]!, segments[from]!)) from--;
		while (to < segments.length - 1 && canJoin(segments[to]!, segments[to + 1]!)) to++;
		const anchor = { line: cell.line, col: segments[from]!.start };
		const focus = { line: cell.line, col: segments[to]!.end - 1 };
		this.current = { anchor, focus, settled: true };
		return selectedText(lines, { anchor, focus });
	}

	/** Select the word under `cell` for a double click and its whole line for a triple click or more. Returns the text to copy. */
	selectClicks(lines: string[], cell: Cell, clickCount: number): string {
		return clickCount >= 3 ? this.selectLine(lines, cell.line) : this.selectWord(lines, cell);
	}

	/** Select all of line `line` of `lines`, settled. Returns the text to copy. */
	selectLine(lines: string[], line: number): string {
		const text = lines[line] ?? "";
		const end = Math.max(0, visibleWidth(text) - 1);
		this.current = { anchor: { line, col: 0 }, focus: { line, col: end }, settled: true };
		return text.trimEnd();
	}
}
