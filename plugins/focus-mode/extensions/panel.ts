/**
 * The actions panel: a centered modal overlay that lists the action log, newest at the bottom, and
 * follows new entries while the view is at the end.
 *
 * Each entry is its full summary behind a status glyph, a duration once finished, and the capped
 * tail of its output in muted text. A bash command is broken one pipeline step per line by
 * `splitShell`, and every line wider than the panel soft-wraps with a hanging indent, so nothing
 * needs sideways scrolling. Nested calls are indented under their parent; every turn opens
 * with a header line carrying the first line of the user message that started it, painted in the
 * transcript's user-message colors, and a turn without calls says so under its header. Within a
 * turn, a dashed rule separates steps: the runs of calls the agent made between pieces of text.
 * Opened with a target step or turn, the panel scrolls so that step or turn's first line is at the
 * top instead of following the end. The overlay wrapper draws the frame and redraws each second so
 * running durations advance, so the panel draws only its text area. Esc, q, space, or the opening
 * shortcut closes it; ↑/↓, PgUp/PgDn, Home, End, and the wheel scroll. A drag over the body selects
 * text, copies it to the clipboard on release, and leaves it highlighted until the next press or
 * key; a double click copies the whole line. The last row carries the key hint, and reads "copied"
 * for a moment after a copy.
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
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CopyFeedback } from "../../shared/copy-feedback.ts";
import { cellAt, highlightSelection, type PaintedText, TextSelection } from "../../shared/selection.ts";
import { Viewport } from "../../shared/viewport.ts";
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
/** Entries beyond this many are dropped from the top of the view. */
const MAX_ENTRIES = 500;
/** Below this many columns of text after the prefix, a line is clipped rather than wrapped. */
const WRAP_MIN = 10;
/** Blank rows kept below the last body line so it does not sit on the status row. */
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

/**
 * `prefix + text`, wrapped so no row exceeds `width`: the first row carries the prefix, later rows
 * blank space of the same width (a hanging indent). Without a width, or when the prefix leaves too
 * little room, the one unwrapped row is returned.
 */
export function wrapRow(prefix: string, text: string, width: number | undefined): string[] {
	const prefixWidth = visibleWidth(prefix);
	if (width === undefined || width - prefixWidth < WRAP_MIN || visibleWidth(text) <= width - prefixWidth) return [prefix + text];
	const rows = wrapTextWithAnsi(text, width - prefixWidth);
	const hang = " ".repeat(prefixWidth);
	return rows.map((row, i) => (i === 0 ? prefix : hang) + row);
}

/** Styled lines for one entry: summary lines, then the tail, each wrapped to `width` when given. */
export function entryLines(entry: ActionEntry, style: PanelStyle, now = Date.now(), width?: number): string[] {
	const color = stripColor(entry);
	const indent = entry.parentId === undefined ? "" : NESTED_INDENT;
	const glyph = color === "muted" ? RUNNING : DONE;
	const summary = summarize(entry, { full: true });
	const lines: string[] = [];
	summary.forEach((text, i) => {
		if (i > 0) {
			// A continuation line's own indent joins the prefix, so its wrapped rows hang under its text.
			const lead = /^ */.exec(text)![0];
			lines.push(...wrapRow(indent + " ".repeat(glyph.length) + lead, text.slice(lead.length), width));
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
		lines.push(...wrapRow(indent + style.fg(color, glyph), head + tail.join(""), width));
	});
	const tailIndent = indent + " ".repeat(glyph.length);
	for (const line of entry.tail) {
		lines.push(...wrapRow(tailIndent + style.fg("dim", TAIL_PREFIX), style.fg("muted", line), width));
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
 * The scrollable body: every group in order, each opened by a header `width` wide carrying its
 * label and followed by its entries' lines wrapped to `width`, or a dim "(no actions)" when it has
 * none; a blank line separates groups, and a dim dashed rule separates the steps within one.
 * Entries whose group is not listed are grouped on their own. Also reports the first line of each
 * step and group.
 */
export function bodyLayout(
	groups: number[],
	entries: ActionEntry[],
	width: number,
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
		lines.push(groupHeader(label(group), width, style));
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
			lines.push(...entryLines(entry, style, now, width));
		}
	});
	return { lines, stepAt, groupAt };
}

/** The lines of `bodyLayout`. */
export function bodyLines(...args: Parameters<typeof bodyLayout>): string[] {
	return bodyLayout(...args).lines;
}

export class ActionsPanel implements Component {
	private entries: () => ActionEntry[];
	private groups: () => number[];
	private label: (group: number) => string;
	private title: string;
	private rows: () => number;
	private requestRender: () => void;
	private theme: Theme;
	private done: () => void;
	private readonly viewport = new Viewport();
	/** Where to scroll on the next paint, cleared once applied. */
	private target: PanelTarget | undefined;
	private readonly selection = new TextSelection();
	private readonly feedback: CopyFeedback;
	/** The body as last painted, unstyled, for mapping the pointer to text. */
	private painted: PaintedText = { lines: [], x: 0, y: 0, width: 0, height: 0, top: 0, pan: 0 };

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
		this.done = options.done;
		this.feedback = new CopyFeedback({ requestRender: options.requestRender, terminal: options.terminal });
	}

	invalidate(): void {}

	dispose(): void {
		this.feedback.dispose();
	}

	handleInput(data: string): void {
		const height = this.viewportHeight();
		this.selection.clear();
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "space") || matchesKey(data, "alt+t")) {
			this.done();
		} else {
			this.viewport.handleKey(data, height);
		}
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.viewport.wheel(event.wheelDelta ?? 0);
			return { handled: true, render: true };
		}
		if (this.selection.dragging) {
			const { result, copy } = this.selection.drag(event, (x, y, edges) => cellAt(this.painted, x, y, edges), this.painted.lines);
			if (copy !== undefined) this.feedback.copy(copy);
			return result;
		}
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			const cell = cellAt(this.painted, event.x, event.y, false);
			this.selection.press(cell);
			return { capture: cell !== undefined, handled: true, render: true };
		}
		if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
			const cell = cellAt(this.painted, event.x, event.y, false);
			if (cell) this.feedback.copy(this.selection.selectLine(this.painted.lines, cell.line));
			return { handled: true, render: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const th = this.theme;
		const content = Math.max(1, width);
		const height = this.viewportHeight();
		const entries = this.entries();
		const now = Date.now();
		const layout = bodyLayout(this.groups(), entries, content, th, this.label, now);
		const body = layout.lines;
		for (let i = 0; i < BODY_PAD_BOTTOM; i++) body.push("");
		if (this.target) {
			const line = "step" in this.target ? layout.stepAt.get(this.target.step) : layout.groupAt.get(this.target.group);
			if (line !== undefined) {
				this.viewport.top = line;
				this.viewport.pinned = false;
			}
			this.target = undefined;
		}
		const top = this.viewport.layout(body.length, height);
		this.painted = { lines: body.map(stripTerminalSequences), x: 0, y: 0, width: content, height, top, pan: 0 };
		const view: string[] = [];
		for (let row = 0; row < height; row++) {
			const line = top + row;
			view.push(highlightSelection(sliceByColumn(body[line] ?? "", 0, content), line, content, this.selection.current, (t) => th.inverse(t)));
		}

		const status = this.feedback.active() ? th.fg("success", "copied") : th.fg("dim", "esc close · ↑↓ scroll");
		return [...view, status];
	}

	/** The frame's title: a bold `actions`, whose actions these are, and the entry count with any running. */
	heading(): string {
		const th = this.theme;
		const entries = this.entries();
		const running = entries.filter((entry) => entry.result === undefined || entry.result.partial === true).length;
		return (
			th.bold(" actions ") +
			(this.title ? th.fg("muted", `${this.title} `) : "") +
			th.fg("dim", `${entries.length}${running ? ` · ${running} running` : ""} `)
		);
	}

	/** Rows left for entries inside the frame's two edges and the status row. */
	private viewportHeight(): number {
		return Math.max(1, panelRows(this.rows()) - 3);
	}
}
