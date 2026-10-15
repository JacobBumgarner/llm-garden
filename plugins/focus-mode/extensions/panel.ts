/**
 * The actions panel: a centered modal overlay that lists the action log, newest at the bottom, and
 * follows new entries while the view is at the end.
 *
 * Each entry is its strip summary behind a status glyph, a duration once finished, and the capped
 * tail of its output in muted text. Nested calls are indented under their parent; every turn opens
 * with a header line carrying the first line of the user message that started it, painted in the
 * transcript's user-message colors, and a turn without calls says so under its header. Within a
 * turn, a dashed rule separates steps: the runs of calls the agent made between pieces of text.
 * Opened with a target step or turn, the panel scrolls so that step or turn's first line is at the
 * top instead of following the end. Lines are drawn at full length: ←/→ and shift+wheel pan the
 * view sideways (wheel-up pans right), `0` pans back to the left edge. Esc, q, space, or the opening
 * shortcut closes it; ↑/↓, PgUp/PgDn, Home, End, g, G, and the wheel scroll. A drag over the body selects text, copies it to
 * the clipboard on release, and leaves it highlighted until the next press or key; a double click
 * copies the whole line. The frame reports "copied" for a moment. A timer redraws the panel each
 * second so running durations tick. Pi forwards only vertical wheel events, so a horizontal trackpad
 * swipe cannot pan.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../ask/extensions/clipboard.ts";
import type { ActionEntry } from "./log.ts";
import { durationLabel, stripColor } from "./strip.ts";
import { summarize } from "./summarize.ts";

const DONE = "● ";
const RUNNING = "○ ";
const ERROR_SUFFIX = " error";
const NESTED_INDENT = "  ";
const TAIL_PREFIX = "│ ";
const NO_ACTIONS = "(no actions)";
/** Drawn between the steps of a turn. */
const STEP_RULE = "┈┈┈┈┈┈┈┈";
/** Columns before a group label, matching the transcript's user message padding. */
const HEADER_PAD = " ";
const TICK_MS = 1000;
/** How long the frame reads "copied" after a copy. */
const COPIED_MS = 1500;
/** Entries beyond this many are dropped from the top of the view. */
const MAX_ENTRIES = 500;
/** Columns of frame around the body: a border and a space on each side. */
const FRAME_X = 2;
const WHEEL_LINES = 3;
/** Columns one ←/→ press pans. */
const PAN_STEP = 8;
/** Blank rows kept below the last body line so it does not sit on the bottom rule. */
const BODY_PAD_BOTTOM = 1;
/** The panel's share of the terminal, and its floor. */
export const PANEL_WIDTH = "70%";
export const PANEL_MIN_WIDTH = 40;
const PANEL_HEIGHT = 0.8;
const PANEL_MIN_ROWS = 8;

/** Rows the panel takes in a terminal `rows` tall. */
export function panelRows(rows: number): number {
	return Math.min(rows, Math.max(PANEL_MIN_ROWS, Math.floor(rows * PANEL_HEIGHT)));
}

/** The theme surface the panel draws with, so tests can pass a plain stub. */
export type PanelStyle = Pick<Theme, "fg" | "bg" | "bold" | "inverse">;

/** Terminal writes the clipboard fallback needs. */
export interface PanelTerminal {
	write(data: string): void;
}

/** A body position: line index into the full body, character column into that line. */
interface Cell {
	line: number;
	col: number;
}

/** A drag from the pressed cell to the one under the pointer; `settled` once released and copied. */
interface Selection {
	anchor: Cell;
	focus: Cell;
	settled: boolean;
}

/** Where the panel scrolls on open: a step's or a turn's first body line. */
export type PanelTarget = { step: number } | { group: number };

/** The body's lines with the line index where each step and each group begins. */
export interface BodyLayout {
	lines: string[];
	stepAt: Map<number, number>;
	groupAt: Map<number, number>;
}

/** Elapsed time to show: the recorded duration once final, else the wall clock since execution began. */
function elapsedMs(entry: ActionEntry, now: number): number | undefined {
	if (entry.durationMs !== undefined) return entry.durationMs;
	if (entry.startedAt === undefined) return undefined;
	return now - entry.startedAt;
}

function before(a: Cell, b: Cell): boolean {
	return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** The selection's cells in reading order. */
function ordered(selection: Selection): [Cell, Cell] {
	return before(selection.focus, selection.anchor) ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, high));
}

/** Styled lines for one entry at full length: summary lines, then the tail. */
export function entryLines(entry: ActionEntry, style: PanelStyle, now = Date.now()): string[] {
	const color = stripColor(entry);
	const indent = entry.parentId === undefined ? "" : NESTED_INDENT;
	const glyph = color === "muted" ? RUNNING : DONE;
	const summary = summarize(entry);
	const lines: string[] = [];
	summary.forEach((text, i) => {
		if (i > 0) {
			lines.push(indent + " ".repeat(glyph.length) + text);
			return;
		}
		const tail: string[] = [];
		if (text.endsWith(ERROR_SUFFIX)) {
			text = text.slice(0, -ERROR_SUFFIX.length);
			tail.push(" ", style.fg("error", ERROR_SUFFIX.trimStart()));
		}
		const duration = durationLabel(elapsedMs(entry, now));
		if (duration) tail.push(style.fg("dim", ` · ${duration}`));
		let head = text;
		if (head === entry.name || head.startsWith(`${entry.name} `)) {
			head = style.fg(color, style.bold(entry.name)) + head.slice(entry.name.length);
		}
		lines.push(indent + style.fg(color, glyph) + head + tail.join(""));
	});
	const tailIndent = indent + " ".repeat(glyph.length);
	for (const line of entry.tail) {
		lines.push(tailIndent + style.fg("dim", TAIL_PREFIX) + style.fg("muted", line));
	}
	return lines;
}

/**
 * A group's header: the label on a line `width` wide in the transcript's user-message colors, so it
 * reads as the message that started the turn. An empty label gives a blank bar.
 */
export function groupHeader(label: string, width: number, style: PanelStyle): string {
	const room = Math.max(1, width - HEADER_PAD.length * 2);
	const text = visibleWidth(label) <= room ? label : truncateToWidth(label, Math.max(0, room - 1), "") + "…";
	const rest = " ".repeat(Math.max(0, width - HEADER_PAD.length - visibleWidth(text)));
	return style.bg("userMessageBg", HEADER_PAD + style.fg("userMessageText", text) + rest);
}

/**
 * The scrollable body: every group in order, each opened by a header `headerWidth` wide carrying its
 * label and followed by its entries' lines, or a dim "(no actions)" when it has none; a blank line
 * separates groups, and a dim dashed rule separates the steps within one. Entries whose group is
 * not listed are grouped on their own. Also reports the first line of each step and group.
 */
export function bodyLayout(
	groups: number[],
	entries: ActionEntry[],
	headerWidth: number,
	style: PanelStyle,
	label: (group: number) => string = () => "",
	now = Date.now(),
): BodyLayout {
	const byGroup = new Map<number, ActionEntry[]>();
	for (const entry of entries.slice(-MAX_ENTRIES)) {
		const list = byGroup.get(entry.group);
		if (list) list.push(entry);
		else byGroup.set(entry.group, [entry]);
	}
	const order = [...new Set([...groups, ...byGroup.keys()])].sort((a, b) => a - b);
	const lines: string[] = [];
	const stepAt = new Map<number, number>();
	const groupAt = new Map<number, number>();
	order.forEach((group, i) => {
		if (i > 0) lines.push("");
		groupAt.set(group, lines.length);
		lines.push(groupHeader(label(group), headerWidth, style));
		const list = byGroup.get(group);
		if (!list) {
			lines.push(style.fg("dim", NO_ACTIONS));
			return;
		}
		let step: number | undefined;
		for (const entry of list) {
			if (entry.parentId === undefined && entry.step !== step) {
				if (step !== undefined) lines.push(style.fg("dim", STEP_RULE));
				step = entry.step;
				if (!stepAt.has(step)) stepAt.set(step, lines.length);
			}
			lines.push(...entryLines(entry, style, now));
		}
	});
	return { lines, stepAt, groupAt };
}

/** The lines of `bodyLayout`. */
export function bodyLines(...args: Parameters<typeof bodyLayout>): string[] {
	return bodyLayout(...args).lines;
}

/** The widest entry line, which bounds how far the view can pan; headers are not counted since they stretch to fit. */
export function entriesWidth(entries: ActionEntry[], style: PanelStyle, now = Date.now()): number {
	let widest = 0;
	for (const entry of entries.slice(-MAX_ENTRIES)) {
		for (const line of entryLines(entry, style, now)) widest = Math.max(widest, visibleWidth(line));
	}
	return widest;
}

/** Scroll offset clamped so the viewport never runs past the body, or pinned to the end. */
export function viewportTop(bodyHeight: number, viewportHeight: number, top: number, pinned: boolean): number {
	const max = Math.max(0, bodyHeight - viewportHeight);
	return pinned ? max : Math.min(Math.max(0, top), max);
}

/** The text a selection covers: the first line from its start column, whole lines between, the last through its end column. */
export function selectedText(lines: string[], selection: { anchor: Cell; focus: Cell }): string {
	const [start, end] = ordered({ ...selection, settled: false });
	const out: string[] = [];
	for (let line = start.line; line <= end.line && line < lines.length; line++) {
		const from = line === start.line ? start.col : 0;
		const to = line === end.line ? end.col + 1 : Number.POSITIVE_INFINITY;
		out.push(sliceByColumn(lines[line]!, from, to - from).trimEnd());
	}
	return out.join("\n");
}

export class ActionsPanel implements Component {
	private entries: () => ActionEntry[];
	private groups: () => number[];
	private label: (group: number) => string;
	private title: string;
	private rows: () => number;
	private requestRender: () => void;
	private theme: Theme;
	private terminal: PanelTerminal;
	private done: () => void;
	private top = 0;
	private pan = 0;
	private pinned = true;
	/** Where to scroll on the next paint, cleared once applied. */
	private target: PanelTarget | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private selection: Selection | undefined;
	private copiedUntil = 0;
	/** The body as last painted, unstyled, with the viewport's offsets and size, for mapping the pointer to text. */
	private painted: { lines: string[]; top: number; pan: number; height: number; width: number } = {
		lines: [],
		top: 0,
		pan: 0,
		height: 0,
		width: 0,
	};

	constructor(options: {
		entries: () => ActionEntry[];
		/** Every turn to list, including ones without calls. Defaults to the groups the entries use. */
		groups?: () => number[];
		label?: (group: number) => string;
		/** Text after "actions" in the title rule, naming whose actions these are. */
		title?: string;
		/** A step or turn to open scrolled to; without it the view follows the end. */
		target?: PanelTarget;
		rows: () => number;
		requestRender: () => void;
		theme: Theme;
		terminal: PanelTerminal;
		done: () => void;
	}) {
		this.entries = options.entries;
		this.groups = options.groups ?? (() => []);
		this.label = options.label ?? (() => "");
		this.title = options.title ?? "";
		this.target = options.target;
		this.rows = options.rows;
		this.requestRender = options.requestRender;
		this.theme = options.theme;
		this.terminal = options.terminal;
		this.done = options.done;
		this.timer = setInterval(() => this.requestRender(), TICK_MS);
		this.timer.unref?.();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	handleInput(data: string): void {
		const height = this.viewportHeight();
		this.selection = undefined;
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "space") || matchesKey(data, "alt+t")) {
			this.done();
		} else if (matchesKey(data, "up")) {
			this.scrollBy(-1);
		} else if (matchesKey(data, "down")) {
			this.scrollBy(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollBy(-height);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollBy(height);
		} else if (matchesKey(data, "left")) {
			this.pan = Math.max(0, this.pan - PAN_STEP);
		} else if (matchesKey(data, "right")) {
			this.pan += PAN_STEP;
		} else if (data === "0") {
			this.pan = 0;
		} else if (matchesKey(data, "home") || data === "g") {
			this.top = 0;
			this.pinned = false;
		} else if (matchesKey(data, "end") || data === "G") {
			this.pinned = true;
		}
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = Math.sign(event.wheelDelta ?? 0);
			// Shift+wheel reports as vertical: wheel-down pans left, wheel-up pans right, so a trackpad swipe tracks the content.
			if (event.shift) this.pan = Math.max(0, this.pan - delta * PAN_STEP);
			else this.scrollBy(delta * WHEEL_LINES);
			return { handled: true, render: true };
		}
		if (this.selection && !this.selection.settled) return this.selectionEvent(event);
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			this.selection = undefined;
			const cell = this.cellAt(event.x, event.y, false);
			if (cell) this.selection = { anchor: cell, focus: cell, settled: false };
			return { capture: cell !== undefined, handled: true, render: true };
		}
		if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
			const cell = this.cellAt(event.x, event.y, false);
			if (cell) this.copyLine(cell.line);
			return { handled: true, render: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(1, width - 2);
		const content = Math.max(1, inner - FRAME_X);
		const height = this.viewportHeight();
		const entries = this.entries();
		const now = Date.now();
		this.pan = clamp(this.pan, 0, Math.max(0, entriesWidth(entries, th, now) - content));
		const layout = bodyLayout(this.groups(), entries, content + this.pan, th, this.label, now);
		const body = layout.lines;
		for (let i = 0; i < BODY_PAD_BOTTOM; i++) body.push("");
		if (this.target) {
			const line = "step" in this.target ? layout.stepAt.get(this.target.step) : layout.groupAt.get(this.target.group);
			if (line !== undefined) {
				this.top = line;
				this.pinned = false;
			}
			this.target = undefined;
		}
		this.top = viewportTop(body.length, height, this.top, this.pinned);
		this.pinned = this.top >= body.length - height;
		this.painted = { lines: body.map(stripTerminalSequences), top: this.top, pan: this.pan, height, width: content };
		const view: string[] = [];
		for (let row = 0; row < height; row++) {
			const line = this.top + row;
			view.push(this.highlighted(sliceByColumn(body[line] ?? "", this.pan, content), line, content));
		}

		const row = (text: string): string => {
			const pad = " ".repeat(Math.max(0, inner - 1 - visibleWidth(text)));
			return th.fg("border", "│") + " " + text + pad + th.fg("border", "│");
		};
		const rule = (label: string, left: string, right: string): string => {
			label = truncateToWidth(label, Math.max(0, inner - 1), "");
			const fill = "─".repeat(Math.max(0, inner - visibleWidth(label) - 1));
			return th.fg("border", `${left}─`) + label + th.fg("border", `${fill}${right}`);
		};
		const running = entries.filter((entry) => entry.result === undefined || entry.result.partial === true).length;
		const title =
			th.bold(" actions ") +
			(this.title ? th.fg("muted", `${this.title} `) : "") +
			th.fg("dim", `${entries.length}${running ? ` · ${running} running` : ""} `);
		const copied = Date.now() < this.copiedUntil;
		const panned = this.pan > 0 ? `→ ${this.pan} · ` : "";
		const hint = copied
			? th.fg("success", " copied ")
			: th.fg("dim", ` ${panned}esc close · ↑↓ scroll `);
		return [rule(title, "╭", "╮"), ...view.map(row), rule(hint, "╰", "╯")];
	}

	/** Rows left for entries inside the top and bottom rules. */
	private viewportHeight(): number {
		return Math.max(1, panelRows(this.rows()) - 2);
	}

	private scrollBy(lines: number): void {
		this.top += lines;
		this.pinned = false;
	}

	/** Map a component-local point to the body cell under it; with `clampEdges` a point outside snaps to the nearest cell. */
	private cellAt(x: number, y: number, clampEdges: boolean): Cell | undefined {
		const { lines, top, pan, height, width } = this.painted;
		if (lines.length === 0) return undefined;
		const bodyX = x - FRAME_X;
		const bodyY = y - 1;
		const inside = bodyX >= 0 && bodyX < width && bodyY >= 0 && bodyY < height;
		if (!clampEdges && !inside) return undefined;
		const line = clamp(top + clamp(bodyY, 0, height - 1), 0, lines.length - 1);
		return { line, col: pan + clamp(bodyX, 0, width - 1) };
	}

	/** Grow the selection while the button is held; on release copy what it covers and leave it highlighted, or drop it when it never moved. */
	private selectionEvent(event: TuiMouseEvent): TuiMouseEventResult {
		const selection = this.selection!;
		if (event.type === "drag" || event.type === "move") {
			const cell = this.cellAt(event.x, event.y, true);
			if (cell) this.selection = { ...selection, focus: cell };
			return { handled: true, render: true };
		}
		if (event.type === "release") {
			const moved = before(selection.anchor, selection.focus) || before(selection.focus, selection.anchor);
			this.selection = moved ? { ...selection, settled: true } : undefined;
			if (moved) this.copy(selectedText(this.painted.lines, selection));
			return { handled: true, render: true };
		}
		return { handled: true };
	}

	/** Select a whole body line and copy it, as a double click does. */
	private copyLine(line: number): void {
		const text = this.painted.lines[line] ?? "";
		const end = Math.max(0, visibleWidth(text) - 1);
		this.selection = { anchor: { line, col: 0 }, focus: { line, col: end }, settled: true };
		this.copy(text.trimEnd());
	}

	private copy(text: string): void {
		if (text === "") return;
		void copyToClipboard(text, this.terminal);
		this.copiedUntil = Date.now() + COPIED_MS;
		setTimeout(() => this.requestRender(), COPIED_MS).unref?.();
	}

	/**
	 * Paint the selected span of a visible line in inverse video, padding the line out first so a
	 * selection past its end still shows. `text` is already panned; selection columns are body
	 * columns, so the pan is subtracted.
	 */
	private highlighted(text: string, line: number, width: number): string {
		if (!this.selection) return text;
		const [start, end] = ordered(this.selection);
		if (line < start.line || line > end.line) return text;
		const from = Math.max(0, (line === start.line ? start.col : 0) - this.pan);
		const to = Math.min(width - 1, (line === end.line ? end.col : Number.POSITIVE_INFINITY) - this.pan);
		if (from > to) return text;
		const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		const span = stripTerminalSequences(sliceByColumn(padded, from, to - from + 1));
		return sliceByColumn(padded, 0, from) + this.theme.inverse(span) + sliceByColumn(padded, to + 1, width - to - 1);
	}
}
