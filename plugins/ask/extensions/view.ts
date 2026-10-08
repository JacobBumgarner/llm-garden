/**
 * The ask form as a pi-tui component: classifies keys, feeds them to the form
 * state, and paints the rows that layout.ts decides on.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Color,
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Markdown,
	matchesKey,
	mixColors,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CHORDS, isPrintable, type KeyName, NAV_KEYS, unwrapPaste } from "./keys.ts";
import {
	columnRows,
	columnWidths,
	formRows,
	hintRow,
	isScrollKey,
	type Layout,
	layout,
	type Mark,
	type Measure,
	type Offsets,
	type PreviewWindow,
	type Row,
	scrolledOffsets,
	type Tab,
} from "./layout.ts";
import { initialState, step } from "./state.ts";
import type { AskQuestion, AskResult, FormEvent, FormState } from "./types.ts";

const INDENT = "    ";
/** Width of the editor gutter: the prompt glyph and a space. */
const EDITOR_GUTTER = "  ";
const ANSWER_GLYPH = "›";
/** The row under the options that opens the text editor. */
const OTHER_LABEL = "Type your own answer…";
const NOTE_GLYPH = "※";
/** Lines an editor shows even when empty, so it reads as a place to write. */
const EDITOR_MIN_LINES = 3;
/** The hidden-line count pi's editor writes into its border when the text overflows. */
const HIDDEN_LINES = /(\d+) more/;
/** Marks the trade-off under a highlighted option, where the reason above it has no prefix. */
const TRADEOFF_PREFIX = "but: ";
/** Trailing run of spaces and SGR sequences, which only padding leaves at a line's end. */
const TRAILING_PADDING = /(?: |\u001b\[[0-9;]*m)+$/;
/** Width code is rendered at so the renderer never wraps it; each line is cut to the column afterwards. */
const NO_WRAP_WIDTH = 10_000;
/** Stand-in the markdown theme emits for fence lines so they can be dropped after rendering; the renderer strips control characters, so it must be printable. */
const FENCE_MARK = "@@ask-fence-7f3a@@";
const COLUMN_RULE = " │";
/** Rails at either end of the code header while code is cut off at that edge. */
const CUT_MARK_LEFT = "‹";
const CUT_MARK_RIGHT = "›";
const TAB_GAP = "   ";
/** The pointer column of a row the cursor is not on, and the mark hover paints there. */
const EMPTY_POINTER = "  ";
const HOVER_POINTER = "› ";
/** How far the hover color moves from the accent toward the text color. */
const HOVER_MIX = 0.5;
const SEND_TAB_GLYPH = "↵";
/** The line over the code column carrying the language and the line range. */
const CODE_HEADER_LINES = 1;

/** Background behind the code column: the neutral grey pi paints behind tool calls, so it reads as a block without competing with the options. */
const CODE_BG = "toolPendingBg";

interface CodeLine {
	text: string;
	cutRight: boolean;
}

const MARK_GLYPHS: Record<Mark, string> = {
	unanswered: "○",
	answered: "✓",
	flagged: "?",
	noted: "※",
};

/** What a painted line responds to when clicked. */
type Hit = { kind: "tab"; index: number } | { kind: "row"; cursor: number } | { kind: "none" };

/** Return the cursor index a click on the row should activate, or null for rows that are not targets. */
function cursorOf(row: Row): number | null {
	switch (row.kind) {
		case "option":
			return row.index;
		case "other":
		case "next":
		case "send":
		case "review":
			return row.at;
		default:
			return null;
	}
}

interface HitLine {
	text: string;
	hit: Hit;
}

type OptionRow = Extract<Row, { kind: "option" }>;
type ReviewRow = Extract<Row, { kind: "review" }>;
type SendRow = Extract<Row, { kind: "send" }>;
type NextRow = Extract<Row, { kind: "next" }>;

/** Map a raw input chunk to a key name: chords, then navigation, then printable text. */
function classify(data: string): KeyName | null {
	if (matchesKey(data, CHORDS.cancel)) return "cancel";
	if (matchesKey(data, CHORDS.note)) return "note";
	if (matchesKey(data, CHORDS.clarify)) return "clarify";
	for (const [name, id] of Object.entries(NAV_KEYS)) {
		if (matchesKey(data, id)) return name as KeyName;
	}
	return isPrintable(data) ? "printable" : null;
}

/** Return the number a chunk types when it is a single digit, else null. */
function pickedNumber(data: string): number | null {
	return /^[1-9]$/.test(data) ? Number(data) : null;
}

/** Return tab or shift+tab when the chunk is one, else null. */
function editorTabKey(data: string): "tab" | "shift+tab" | null {
	if (matchesKey(data, NAV_KEYS["shift+tab"])) return "shift+tab";
	if (matchesKey(data, NAV_KEYS.tab)) return "tab";
	return null;
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function draftEvent(which: FormState["mode"], text: string): FormEvent {
	return { type: which === "note" ? "noteDraft" : "draft", text };
}

function currentQuestion(state: FormState): AskQuestion | undefined {
	return state.questions[state.current];
}

/** Truncate or pad a line to exactly the width in terminal columns. */
/** Drop trailing spaces and the style codes around them; the markdown renderer pads code lines out to the render width. */
function trimPadding(line: string): string {
	return line.replace(TRAILING_PADDING, "");
}

function fitToWidth(line: string, width: number): string {
	const fitted = truncateToWidth(line, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

export class AskForm implements Component, Focusable {
	private state: FormState;
	private readonly textEditor: Editor;
	private readonly noteEditor: Editor;
	private readonly markdown = new Map<string, Markdown>();
	private codeTheme: ReturnType<typeof getMarkdownTheme> | undefined;
	private windowOffset = 0;
	private previewWindow: PreviewWindow | undefined;
	private lastLayout: Layout | undefined;
	/** One entry per painted line, built by the last render. */
	private hits: Hit[] = [];
	/** Column spans of the tabs in the strip, from the last render. */
	private tabSpans: { index: number; start: number; end: number }[] = [];
	/** What the pointer rests on, from the last move event. */
	private hover: Hit = { kind: "none" };
	private hoverFg: Color | undefined;
	private followCursor = true;
	/** Set when an editor's onSubmit ran inside handleInput; the editor's text is then stale for the next state, so it must not be sent as a draft. */
	private submitted = false;
	private finished = false;
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: AskResult) => void;

	constructor(tui: TUI, theme: Theme, questions: AskQuestion[], done: (result: AskResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.state = initialState(questions);
		this.textEditor = new Editor(tui, editorTheme(theme));
		this.noteEditor = new Editor(tui, editorTheme(theme));
		this.textEditor.onSubmit = (value) => this.submitFrom({ type: "draft", text: value });
		this.noteEditor.onSubmit = (value) => this.submitFrom({ type: "noteDraft", text: value });
		this.loadTextEditor();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncEditorFocus();
	}

	invalidate(): void {
		this.markdown.clear();
		this.hoverFg = undefined;
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, CHORDS.cancel)) this.dispatch({ type: "key", key: "cancel" });
		else if (this.state.mode !== "list") this.editorInput(data);
		else this.listInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.finished) return undefined;
		if (event.type === "wheel") return this.wheel(event.wheelDelta ?? 0);
		if (event.type === "move") return this.moveTo(this.hitAt(event.x, event.y));
		if (event.type !== "click" || event.button !== "left") return undefined;
		const hit = this.hitAt(event.x, event.y);
		if (hit.kind === "tab") this.dispatch({ type: "jump", question: hit.index });
		else if (hit.kind === "row") this.activate(hit.cursor);
		this.tui.requestRender();
		return { handled: true, focus: true };
	}

	/** Return what sits under a point: a tab only when the pointer is on its label, else the line's target. */
	private hitAt(x: number, y: number): Hit {
		const hit = this.hits[y] ?? { kind: "none" };
		if (hit.kind !== "tab") return hit;
		const index = this.tabAt(x);
		return index === undefined ? { kind: "none" } : { kind: "tab", index };
	}

	/** Record the hovered target and repaint only when it changed. */
	private moveTo(hit: Hit): TuiMouseEventResult {
		const changed = hit.kind !== this.hover.kind || JSON.stringify(hit) !== JSON.stringify(this.hover);
		this.hover = hit;
		return { handled: true, render: changed };
	}

	private wheel(delta: number): TuiMouseEventResult {
		const key: KeyName = delta < 0 ? "shift+up" : "shift+down";
		for (let i = 0; i < Math.abs(delta); i++) this.scroll(key);
		this.tui.requestRender();
		return { handled: true };
	}

	private tabAt(x: number): number | undefined {
		return this.tabSpans.find((span) => x >= span.start && x < span.end)?.index;
	}

	/** Act on a clicked row: leave an open editor first, keeping its text as the draft, unless the question has no list to return to. */
	private activate(cursor: number): void {
		const mode = this.state.mode;
		if (mode !== "list") {
			if ((currentQuestion(this.state)?.options ?? []).length === 0) return;
			this.dispatch(draftEvent(mode, this.editorFor(mode).getExpandedText()));
			this.dispatch({ type: "key", key: "escape" });
		}
		this.dispatch({ type: "activate", cursor });
	}

	render(width: number): string[] {
		this.syncEditorFocus();
		const rows = formRows(this.tui.terminal.rows);
		const painted = new Map<Row, { width: number; lines: string[] }>();
		const paint = (row: Row, at: number) => this.paintCached(painted, row, at);
		const measure: Measure = {
			height: (row, at) => paint(row, at).length,
			codeWidth: (markdown) => Math.max(0, ...this.paintCode(markdown, NO_WRAP_WIDTH, "").map(visibleWidth)),
		};
		const view = layout(this.state, width, rows, measure, this.offsets(), this.followCursor);
		this.windowOffset = view.windowOffset;
		this.previewWindow = view.preview;
		this.lastLayout = view;
		return this.compose(view, width, paint);
	}

	private offsets(): Offsets {
		return { window: this.windowOffset, preview: this.previewWindow };
	}

	private editorInput(data: string): void {
		const which = this.state.mode;
		if (matchesKey(data, NAV_KEYS.escape)) return this.dispatch({ type: "key", key: "escape" });
		const editor = this.editorFor(which);
		const tab = editorTabKey(data);
		if (tab) {
			this.dispatch(draftEvent(which, editor.getExpandedText()));
			return this.dispatch({ type: "key", key: tab });
		}
		this.submitted = false;
		editor.handleInput(data);
		if (this.submitted) return;
		// getExpandedText, not getText: pasted blocks the editor collapses to a marker must reach the state whole.
		this.dispatch(draftEvent(which, editor.getExpandedText()));
	}

	private listInput(data: string): void {
		const digit = pickedNumber(data);
		if (digit !== null) return this.dispatch({ type: "pick", number: digit });
		const key = classify(data);
		if (key === null) return;
		if (isScrollKey(key)) return this.scroll(key);
		this.dispatch({ type: "key", key });
		if (key !== "printable" || this.state.mode !== "text") return;
		// The chunk that switched modes never reached the editor; handleInput would treat a paste as keystrokes.
		this.textEditor.insertTextAtCursor(unwrapPaste(data));
		this.dispatch({ type: "draft", text: this.textEditor.getExpandedText() });
	}

	private scroll(key: KeyName): void {
		if (!this.lastLayout) return;
		const next = scrolledOffsets(this.lastLayout, key);
		this.windowOffset = next.window;
		this.previewWindow = next.preview;
		this.followCursor = false;
		// A second scroll key before the next render must build on this one, not on the painted layout.
		this.lastLayout = { ...this.lastLayout, windowOffset: next.window, preview: next.preview };
	}

	private submitFrom(event: FormEvent): void {
		this.submitted = true;
		this.dispatch(event);
		this.dispatch({ type: "key", key: "enter" });
	}

	private dispatch(event: FormEvent): void {
		const before = this.state;
		this.state = step(before, event);
		this.followCursor = true;
		this.syncEditors(before);
		if (this.state.result && !this.finished) {
			this.finished = true;
			this.done(this.state.result);
		}
	}

	private syncEditors(before: FormState): void {
		const moved = before.current !== this.state.current;
		if (moved) {
			this.windowOffset = 0;
			this.previewWindow = undefined;
		}
		if (moved || (before.mode !== "text" && this.state.mode === "text")) this.loadTextEditor();
		if (before.mode !== "note" && this.state.mode === "note") this.noteEditor.setText(this.state.noteDraft);
		this.syncEditorFocus();
	}

	private editorFor(which: FormState["mode"]): Editor {
		return which === "note" ? this.noteEditor : this.textEditor;
	}

	private loadTextEditor(): void {
		const question = currentQuestion(this.state);
		this.textEditor.setText(question ? (this.state.drafts.get(question.id) ?? "") : "");
	}

	private syncEditorFocus(): void {
		this.textEditor.focused = this._focused && this.state.mode === "text";
		this.noteEditor.focused = this._focused && this.state.mode === "note";
	}

	/** Paint the whole form and record, line by line, what a click there reaches. */
	private compose(view: Layout, width: number, paint: (row: Row, at: number) => string[]): string[] {
		const rule = this.theme.fg("accent", "─".repeat(width));
		const lines = [rule];
		const hits: Hit[] = [{ kind: "none" }];
		if (view.tabs.length > 0) {
			lines.push(this.paintTabs(view.tabs, width), "");
			hits.push({ kind: "tab", index: view.tabs.findIndex((tab) => tab.current) }, { kind: "none" });
		}
		const body = view.preview ? this.paintColumns(view, view.preview, width, paint) : this.paintWindow(view, width, paint);
		lines.push(...body.map((line) => line.text));
		hits.push(...body.map((line) => line.hit));
		lines.push(rule, ...paint(hintRow(view), width));
		this.hits = hits;
		return lines.map((line) => truncateToWidth(line, width));
	}

	/** Paint the visible slice of the column, each line tagged with the row it came from. */
	private paintWindow(view: Layout, width: number, paint: (row: Row, at: number) => string[]): HitLine[] {
		const column = columnRows(view).flatMap((row) => {
			const cursor = cursorOf(row);
			const hit: Hit = cursor === null ? { kind: "none" } : { kind: "row", cursor };
			const lines = paint(row, width);
			return this.hovered(hit) ? this.hoverMarked(lines).map((text) => ({ text, hit })) : lines.map((text) => ({ text, hit }));
		});
		return column.slice(view.windowOffset, view.windowOffset + view.budget);
	}

	/** Paint the option window on the left and the preview window on the right, the same height, split by a rule. */
	private paintColumns(
		view: Layout,
		preview: PreviewWindow,
		width: number,
		paint: (row: Row, at: number) => string[],
	): HitLine[] {
		const { left, right } = columnWidths(width);
		const options = this.paintWindow(view, left, paint);
		const code = this.codeLines(preview.markdown, right, preview.column);
		const shown = code.slice(preview.offset, preview.offset + view.budget - CODE_HEADER_LINES);
		const rails = {
			left: preview.column > 0 ? CUT_MARK_LEFT : " ",
			right: shown.some((line) => line.cutRight) ? CUT_MARK_RIGHT : " ",
		};
		const plain = { left: " ", right: " " };
		const header = this.codeCell(this.codeHeader(preview, right, shown.length, code.length), right, rails);
		const body = [header, ...shown.map((line) => this.codeCell(line.text, right, plain))];
		const height = Math.max(options.length, body.length);
		const blank = this.gutter(" ") + " ".repeat(right) + " ";
		return Array.from({ length: height }, (_, i) => ({
			text: fitToWidth(options[i]?.text ?? "", left) + (body[i] ?? blank),
			hit: options[i]?.hit ?? { kind: "none" },
		}));
	}

	/** Render the code lines, noting which ones run past the right edge at this pan. */
	private codeLines(markdown: string, width: number, column: number): CodeLine[] {
		return this.paintCode(markdown, NO_WRAP_WIDTH, "").map((line) => ({
			text: sliceByColumn(line, column, width, true),
			cutRight: visibleWidth(line) > column + width,
		}));
	}

	private hovered(hit: Hit): boolean {
		return this.hover.kind === hit.kind && JSON.stringify(this.hover) === JSON.stringify(hit);
	}

	/** Put a dim pointer in the empty pointer column of a hovered row; a row already carrying the cursor keeps its own. */
	private hoverMarked(lines: string[]): string[] {
		const [first, ...rest] = lines;
		if (!first.startsWith(EMPTY_POINTER)) return lines;
		return [this.theme.fg("dim", HOVER_POINTER) + first.slice(EMPTY_POINTER.length), ...rest];
	}

	private gutter(rail: string): string {
		return this.theme.fg("dim", COLUMN_RULE) + this.theme.fg("accent", rail);
	}

	/** Paint one code-column line: rule and left rail, the text on the code background, then the right rail. */
	private codeCell(text: string, width: number, rails: { left: string; right: string }): string {
		return `${this.gutter(rails.left)}${this.theme.bg(CODE_BG, fitToWidth(text, width))}${this.theme.fg("accent", rails.right)}`;
	}

	/** Paint the text over the code: the fence language on the left and the visible line range on the right. */
	private codeHeader(preview: PreviewWindow, width: number, shownCount: number, total: number): string {
		const first = total === 0 ? 0 : preview.offset + 1;
		const range = `lines ${first}–${preview.offset + shownCount} of ${total}`;
		const lang = preview.lang ?? "";
		const gap = Math.max(1, width - visibleWidth(lang) - visibleWidth(range));
		return this.theme.fg("dim", fitToWidth(lang + " ".repeat(gap) + range, width));
	}

	/** Paint the strip: the current tab in accent behind a pointer, the rest muted behind their marks, and an answered count at the right edge. */
	private paintTabs(tabs: Tab[], width: number): string {
		const labels = tabs.map((tab, index) => {
			const text = tab.mark ? `${MARK_GLYPHS[tab.mark]} ${tab.label}` : `${SEND_TAB_GLYPH} ${tab.label}`;
			const painted = tab.current ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("muted", text);
			return this.hovered({ kind: "tab", index }) ? this.theme.underline(painted) : painted;
		});
		const strip = " " + labels.join(TAB_GAP);
		let start = 1;
		this.tabSpans = labels.map((label, index) => {
			const span = { index, start, end: start + visibleWidth(label) };
			start = span.end + TAB_GAP.length;
			return span;
		});
		const questions = tabs.filter((tab) => tab.mark);
		const done = questions.filter((tab) => tab.mark !== "unanswered").length;
		const counter = `${done}/${questions.length} answered`;
		const gap = Math.max(1, width - visibleWidth(strip) - counter.length - 1);
		return strip + " ".repeat(gap) + this.theme.fg("dim", counter);
	}

	private paintCached(cache: Map<Row, { width: number; lines: string[] }>, row: Row, width: number): string[] {
		const hit = cache.get(row);
		if (hit?.width === width) return hit.lines;
		const lines = this.paintRow(row, width);
		cache.set(row, { width, lines });
		return lines;
	}

	private paintRow(row: Row, width: number): string[] {
		switch (row.kind) {
			case "question":
				return this.wrap(this.theme.bold(row.text), width, "");
			case "context":
				return this.wrap(this.theme.fg("muted", row.text), width, "");
			case "spacer":
				return [""];
			case "note":
				return this.wrap(`${this.theme.fg("accent", NOTE_GLYPH)} ${this.theme.fg("muted", `note: ${row.text}`)}`, width, "  ");
			case "option":
				return this.paintOption(row, width);
			case "preview":
				return this.paintCode(row.markdown, width, INDENT);
			case "code":
				return this.paintCode(row.markdown, width, "");
			case "editor":
				return this.paintEditor(row.which, width);
			case "review":
				return this.paintReview(row, width);
			case "send":
				return this.paintSend(row);
			case "next":
				return this.paintNext(row);
			case "other":
				return [`${this.pointer(row.highlighted)}${this.theme.fg("muted", `${row.number}. `)}${this.label(OTHER_LABEL, row, "muted")}`];
			case "hint":
				return this.wrap(this.theme.fg("dim", row.text), width, "");
		}
	}

	/** Paint a row's label: accent when it carries the cursor, a lighter accent under the pointer, else its resting color. */
	private label(text: string, row: Row, resting?: string): string {
		if ("highlighted" in row && row.highlighted) return this.theme.fg("accent", text);
		const cursor = cursorOf(row);
		if (cursor !== null && this.hovered({ kind: "row", cursor })) return this.theme.style(text, { fg: this.hoverColor() });
		return resting ? this.theme.fg(resting, text) : text;
	}

	/** The hover color: the accent mixed toward the text color, so it reads as a lighter accent. */
	private hoverColor(): Color {
		this.hoverFg ??= mixColors(this.theme.colors.accent, this.theme.colors.text, HOVER_MIX);
		return this.hoverFg;
	}

	private pointer(highlighted: boolean): string {
		return highlighted ? this.theme.fg("accent", "❯ ") : EMPTY_POINTER;
	}

	/** Paint an option: its label line, then its full reason and trade-off when highlighted, else one truncated trade-off line. */
	private paintOption(row: OptionRow, width: number): string[] {
		const box = row.multi ? (row.checked ? "[x] " : "[ ] ") : "";
		const tag = row.recommended ? this.theme.fg("success", " (Recommended)") : "";
		const chosen = row.chosen && !row.multi ? this.theme.fg("success", " ●") : "";
		const label = this.label(row.label, row);
		const number = this.theme.fg("muted", `${row.index + 1}. `);
		const lines = this.wrap(`${this.pointer(row.highlighted)}${number}${box}${label}${tag}${chosen}`, width, INDENT);
		if (row.highlighted) {
			if (row.reason) lines.push(...this.indented(this.theme.fg("muted", row.reason), width));
			if (row.tradeoff) lines.push(...this.indented(this.theme.fg("dim", `${TRADEOFF_PREFIX}${row.tradeoff}`), width));
		} else if (row.tradeoff) {
			lines.push(INDENT + this.theme.fg("dim", truncateToWidth(row.tradeoff, Math.max(1, width - INDENT.length), "…")));
		}
		return lines;
	}

	/** Paint an editor as a gutter-marked block: `›` for an answer, `✎` for a note, at least three lines, with a dim overflow line where the editor's own borders would have reported hidden lines. */
	private paintEditor(which: "text" | "note", width: number): string[] {
		const rendered = this.editorFor(which).render(Math.max(1, width - EDITOR_GUTTER.length));
		const body = rendered.slice(1, -1);
		while (body.length < EDITOR_MIN_LINES) body.push("");
		const glyph = which === "note" ? NOTE_GLYPH : ANSWER_GLYPH;
		const lines = body.map((line, index) => (index === 0 ? this.theme.fg("accent", glyph + " ") : EDITOR_GUTTER) + line);
		return [...this.overflowLine(rendered[0], "↑"), ...lines, ...this.overflowLine(rendered[rendered.length - 1], "↓")];
	}

	/** Turn an editor border line into a dim `↑ n more` line, or nothing when it reports no hidden lines. */
	private overflowLine(border: string, arrow: string): string[] {
		const hidden = HIDDEN_LINES.exec(border);
		return hidden ? [EDITOR_GUTTER + this.theme.fg("dim", `${arrow} ${hidden[1]} more`)] : [];
	}

	private paintReview(row: ReviewRow, width: number): string[] {
		const label = this.label(row.label, row);
		const summary = this.theme.fg("muted", row.summary);
		return [truncateToWidth(`${this.pointer(row.highlighted)}${MARK_GLYPHS[row.mark]} ${label}  ${summary}`, width)];
	}

	private paintNext(row: NextRow): string[] {
		return [this.button(row.label, row)];
	}

	private paintSend(row: SendRow): string[] {
		const note = row.enabled ? "" : this.theme.fg("dim", "  answer or flag every question first");
		return [this.button("Send", row) + note];
	}

	/** Paint a commit row as a bracketed button: accent when highlighted, plain when enabled, dim when inert. */
	private button(label: string, row: Extract<Row, { kind: "next" | "send" }>): string {
		const text = `[ ${label} ]`;
		const painted = row.enabled ? this.label(text, row) : this.theme.fg("dim", text);
		return `${this.pointer(row.highlighted)}${painted}`;
	}

	/** Render a preview unwrapped and without its fences, cutting each line at the width. */
	private paintCode(text: string, width: number, indent: string): string[] {
		const key = `${FENCE_MARK}${text}`;
		let component = this.markdown.get(key);
		if (!component) {
			component = new Markdown(text, 0, 0, this.fencelessTheme());
			this.markdown.set(key, component);
		}
		const inner = Math.max(1, width - indent.length);
		return component
			.render(NO_WRAP_WIDTH)
			.filter((line) => !line.includes(FENCE_MARK))
			.map((line) => indent + sliceByColumn(trimPadding(line), 0, inner, true));
	}

	private fencelessTheme(): ReturnType<typeof getMarkdownTheme> {
		this.codeTheme ??= { ...getMarkdownTheme(), codeBlockBorder: () => FENCE_MARK, codeBlockIndent: "" };
		return this.codeTheme;
	}

	/** Wrap text to the width, indenting every line after the first. */
	private wrap(text: string, width: number, indent: string): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, width - indent.length));
		return lines.length === 0 ? [""] : lines.map((line, index) => (index === 0 ? line : indent + line));
	}

	/** Wrap text to the width, indenting every line. */
	private indented(text: string, width: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width - INDENT.length)).map((line) => INDENT + line);
	}
}
