/**
 * Decide what the form shows for a state and a terminal size, as data: the tab
 * strip, the rows of the option column, the preview column, state marks, and
 * the line windows.
 * No pi import, so the layout tests run without a terminal.
 */

import { CHORDS } from "./keys.ts";
import { allAnswered, inReview, isBatch, nextRowIndex, onNextRow, onOtherRow, onSendRow, otherRowIndex, sendRowIndex } from "./state.ts";
import type { Answer, AskOption, AskQuestion, FormState, KeyName } from "./types.ts";

export type Mark = "unanswered" | "answered" | "flagged" | "noted";

export interface Tab {
	label: string;
	/** Absent on the Send tab, which opens the review step. */
	mark?: Mark;
	current: boolean;
}

export type Row =
	| { kind: "question"; text: string }
	| { kind: "context"; text: string }
	/** The note saved on the current question, shown under its options while the note editor is closed. */
	| { kind: "note"; text: string }
	| { kind: "spacer" }
	| {
			kind: "option";
			index: number;
			label: string;
			tradeoff?: string;
			reason?: string;
			highlighted: boolean;
			checked: boolean;
			chosen: boolean;
			recommended: boolean;
			multi: boolean;
	  }
	| { kind: "preview"; markdown: string }
	| { kind: "code"; markdown: string }
	| { kind: "editor"; which: "text" | "note" }
	| { kind: "review"; at: number; id: string; label: string; mark: Mark; summary: string; highlighted: boolean }
	| { kind: "send"; at: number; enabled: boolean; highlighted: boolean }
	| { kind: "next"; at: number; label: string; enabled: boolean; highlighted: boolean }
	| { kind: "other"; at: number; number: number; highlighted: boolean }
	| { kind: "hint"; text: string };

/** A preview shown in its own column, and the first of its lines on screen. */
export interface PreviewWindow {
	markdown: string;
	offset: number;
	/** First visible character column of each code line. */
	column: number;
	/** Language from the first code fence, shown in the header over the column. */
	lang?: string;
}

/** The scroll state carried between layouts: the option window and the preview column it last showed. */
export interface Offsets {
	window: number;
	preview?: PreviewWindow;
}

export interface Layout {
	/** The highlighted option's preview as a right-hand column; absent when it renders inline or there is none. */
	preview?: PreviewWindow;
	/** The tab strip, one entry per question; empty for a single question. */
	tabs: Tab[];
	/** The column's rows top to bottom, then the hint row last. */
	rows: Row[];
	/** First visible line of the column, counting the painted lines of every row before the hint. */
	windowOffset: number;
	/** Lines available to each column below the strip and above the hint. */
	budget: number;
}

/** How the view sizes content: a row's painted height at a width, and the widest line of a preview's code. */
export interface Measure {
	height(row: Row, width: number): number;
	codeWidth(markdown: string): number;
}

/** Narrowest terminal that gets a preview column: below it the option column wraps every trade-off and the code column wraps most code lines. */
export const PREVIEW_COLUMN_MIN_WIDTH = 100;
/** Share of the width the option column takes beside a preview; an even split, since the highlighted option's full text is the longest thing either side shows. */
const OPTION_COLUMN_SHARE = 0.5;
/** Columns the gutter takes: a space, the vertical rule, a space, plus one trailing column so code never touches the edge. */
const GUTTER_WIDTH = 4;

/** Share of the terminal the form may take, so the conversation above it stays readable. */
const FORM_SHARE = 0.55;
/** Fewest lines the form takes on a short terminal, enough for the frame, a question, and a few options. */
const MIN_FORM_LINES = 12;
/** Lines the tab strip takes: the strip and the blank line under it. */
const TAB_STRIP_LINES = 2;
const SEND_TAB_LABEL = "Send";
/** Lines pi draws below a custom component, which replaces its input box: a blank and the status line. */
const RESERVED_BELOW = 2;
/** The rules painted above and below the form. */
const RULE_LINES = 2;

/** Lines each scroll key moves the scrolled column by, and in which direction; `page` means one window. */
const SCROLL_KEYS: Partial<Record<KeyName, { axis: "lines" | "columns"; direction: -1 | 1; page: boolean }>> = {
	pageUp: { axis: "lines", direction: -1, page: true },
	pageDown: { axis: "lines", direction: 1, page: true },
	"shift+up": { axis: "lines", direction: -1, page: false },
	"shift+down": { axis: "lines", direction: 1, page: false },
	"shift+left": { axis: "columns", direction: -1, page: false },
	"shift+right": { axis: "columns", direction: 1, page: false },
};
/** Characters one horizontal pan of the code column moves, about one indent level of most code. */
const PAN_STEP = 8;

const HINT_SEPARATOR = " • ";
const CANCEL_HINT = "esc cancel";

/**
 * Return the lines `layout()` gets on a terminal of the given height: the
 * form's share of it, never under the floor nor past what pi leaves free,
 * less the two rules that frame the form.
 */
export function formRows(terminalRows: number): number {
	const share = Math.max(MIN_FORM_LINES, Math.floor(terminalRows * FORM_SHARE));
	return Math.max(1, Math.min(share, terminalRows - RESERVED_BELOW) - RULE_LINES);
}

/** Split a width into the option column and the preview column on either side of the gutter. */
export function columnWidths(width: number): { left: number; right: number } {
	const left = Math.floor(width * OPTION_COLUMN_SHARE);
	return { left, right: Math.max(1, width - left - GUTTER_WIDTH) };
}

/** Return a question's mark from its answer state; a note shows only once the question is answered. */
function markOf(state: FormState, id: string): Mark {
	const answer = state.answers.get(id);
	if (!answer) return "unanswered";
	if (answer.kind === "clarify") return "flagged";
	return state.notes.has(id) ? "noted" : "answered";
}

function optionCount(question: AskQuestion): number {
	return question.options?.length ?? 0;
}

function labelOf(question: AskQuestion, index: number): string {
	return question.label ?? `Q${index + 1}`;
}

/** One tab per question plus a Send tab for the review step. */
function tabsOf(state: FormState): Tab[] {
	const questions = state.questions.map((question, index) => ({
		label: labelOf(question, index),
		mark: markOf(state, question.id),
		current: index === state.current,
	}));
	return [...questions, { label: SEND_TAB_LABEL, current: inReview(state) }];
}

function chosenSet(answer: Answer | undefined): Set<number> {
	return new Set(answer?.kind === "selected" ? answer.indices : []);
}

function optionRow(state: FormState, question: AskQuestion, option: AskOption, index: number): Row {
	return {
		kind: "option",
		index,
		label: option.label,
		tradeoff: option.tradeoff,
		reason: option.recommended || undefined,
		highlighted: index === state.cursor,
		checked: state.checked.get(question.id)?.has(index) ?? false,
		chosen: chosenSet(state.answers.get(question.id)).has(index),
		recommended: Boolean(option.recommended),
		multi: question.multi ?? false,
	};
}

/** Build the row that commits a multi-select; enabled once something is checked. */
function nextRow(state: FormState, question: AskQuestion): Row {
	return {
		kind: "next",
		at: nextRowIndex(question),
		label: isBatch(state) ? "Next" : "Done",
		enabled: (state.checked.get(question.id)?.size ?? 0) > 0,
		highlighted: onNextRow(state),
	};
}

function optionRows(state: FormState, question: AskQuestion, inlinePreview: boolean): Row[] {
	const rows: Row[] = [];
	(question.options ?? []).forEach((option, index) => {
		rows.push(optionRow(state, question, option, index));
		if (inlinePreview && index === state.cursor && option.preview) rows.push({ kind: "preview", markdown: option.preview });
	});
	if (optionCount(question) > 0) {
		rows.push({ kind: "other", at: otherRowIndex(question), number: otherRowIndex(question) + 1, highlighted: onOtherRow(state) });
	}
	if (showsTextEditor(state, question)) rows.push({ kind: "editor", which: "text" });
	if (question.multi || isBatch(state)) rows.push({ kind: "spacer" });
	if (question.multi) rows.push(nextRow(state, question));
	if (isBatch(state)) rows.push({ kind: "send", at: sendRowIndex(question), enabled: allAnswered(state), highlighted: onSendRow(state) });
	return rows;
}

/** Return the highlighted option's preview when it gets its own column at this width. */
function columnPreview(state: FormState, width: number): string | undefined {
	if (inReview(state) || width < PREVIEW_COLUMN_MIN_WIDTH) return undefined;
	return state.questions[state.current].options?.[state.cursor]?.preview;
}

/** Show the text editor while typing, and in list mode whenever a draft is kept. */
function showsTextEditor(state: FormState, question: AskQuestion): boolean {
	if (state.mode === "text") return true;
	return state.mode === "list" && (state.drafts.get(question.id) ?? "").trim() !== "";
}

function questionRows(state: FormState, inlinePreview: boolean): Row[] {
	const question = state.questions[state.current];
	const rows: Row[] = [{ kind: "question", text: question.question }];
	if (question.context) rows.push({ kind: "context", text: question.context });
	rows.push({ kind: "spacer" }, ...optionRows(state, question, inlinePreview));
	if (state.mode === "note") rows.push({ kind: "editor", which: "note" });
	else {
		const note = state.notes.get(question.id);
		if (note) rows.push({ kind: "spacer" }, { kind: "note", text: note });
	}
	return rows;
}

function answerSummary(question: AskQuestion, answer: Answer | undefined): string {
	if (!answer) return "unanswered";
	if (answer.kind === "clarify") return "needs clarification";
	if (answer.kind === "text") return answer.text.split("\n")[0];
	return answer.indices.map((index) => question.options?.[index]?.label ?? "?").join(", ");
}

function reviewRow(state: FormState, question: AskQuestion, index: number): Row {
	const note = state.notes.has(question.id) ? " + note" : "";
	return {
		kind: "review",
		at: index,
		id: question.id,
		label: labelOf(question, index),
		mark: markOf(state, question.id),
		summary: answerSummary(question, state.answers.get(question.id)) + note,
		highlighted: state.cursor === index,
	};
}

function reviewRows(state: FormState): Row[] {
	return [
		{ kind: "question", text: "Review your answers" },
		{ kind: "spacer" },
		...state.questions.map((question, index) => reviewRow(state, question, index)),
		{ kind: "spacer" },
		{
			kind: "send",
			at: state.questions.length,
			enabled: allAnswered(state),
			highlighted: state.cursor === state.questions.length,
		},
	];
}

/** The list-mode hint: what the keys do here, most used first, in one line on a wide terminal. */
function listHint(state: FormState, previewColumn: boolean): string {
	const question = state.questions[state.current];
	const parts = [question.multi ? "number/space toggle" : "number/enter choose", "type to answer"];
	if (isBatch(state)) parts.push("tab question");
	parts.push(`${CHORDS.note} note`, `${CHORDS.clarify} clarify`);
	if (previewColumn) parts.push("shift+arrows scroll code");
	parts.push(CANCEL_HINT);
	return parts.join(HINT_SEPARATOR);
}

function editorHint(state: FormState, submit: string, escape: string): string {
	const parts = [submit, "shift+enter newline"];
	if (isBatch(state)) parts.push("tab question");
	parts.push(escape);
	return parts.join(HINT_SEPARATOR);
}

function textHint(state: FormState): string {
	const noOptions = (state.questions[state.current].options ?? []).length === 0;
	return editorHint(state, "enter submit", noOptions ? CANCEL_HINT : "esc back");
}

function hintText(state: FormState, previewColumn: boolean): string {
	if (inReview(state)) return ["enter open or send", "tab question", CANCEL_HINT].join(HINT_SEPARATOR);
	if (state.mode === "text") return textHint(state);
	if (state.mode === "note") return editorHint(state, "enter save note", "esc back");
	return listHint(state, previewColumn);
}

function isFocusRow(row: Row): boolean {
	switch (row.kind) {
		case "option":
		case "review":
		case "send":
		case "next":
		case "other":
			return row.highlighted;
		default:
			return false;
	}
}

/** Return the row the window must keep visible: the active editor, else the highlighted row. */
function focusIndex(state: FormState, rows: Row[]): number {
	if (!inReview(state) && state.mode !== "list") {
		const which = state.mode === "note" ? "note" : "text";
		const editor = rows.findIndex((row) => row.kind === "editor" && row.which === which);
		if (editor !== -1) return editor;
	}
	return Math.max(0, rows.findIndex(isFocusRow));
}

/** Return each row's first line index, plus the total line count as the last entry. */
function lineStarts(heights: number[]): number[] {
	const starts = [0];
	for (const height of heights) starts.push(starts[starts.length - 1] + height);
	return starts;
}

/**
 * Return the line span the window should show for the focus row: the row and
 * its preview when they fit together, else the row and half a window of its
 * preview, so a tall preview does not scroll the question off screen.
 */
function focusSpan(rows: Row[], starts: number[], focus: number, budget: number): [number, number] {
	const first = starts[focus];
	const rowEnd = starts[focus + 1];
	if (rows[focus + 1]?.kind !== "preview") return [first, rowEnd];
	const end = starts[focus + 2];
	if (end - first <= budget) return [first, end];
	return [first, Math.min(end, rowEnd + Math.ceil(budget / 2))];
}

/** Move the offset as little as possible so the span's first line shows, and as much after it as fits. */
function follow(offset: number, budget: number, [first, end]: [number, number]): number {
	if (first < offset) return first;
	if (end > offset + budget) return Math.min(first, end - budget);
	return offset;
}

function chooseOffset(
	state: FormState,
	rows: Row[],
	heights: number[],
	budget: number,
	offset: number,
	followCursor: boolean,
): number {
	const starts = lineStarts(heights);
	const total = starts[starts.length - 1];
	let next = Math.max(0, offset);
	if (followCursor) next = follow(next, budget, focusSpan(rows, starts, focusIndex(state, rows), budget));
	return Math.max(0, Math.min(next, total - budget));
}

/** Return the rows of the windowed column, everything but the trailing hint. */
export function columnRows(view: Layout): Row[] {
	return view.rows.slice(0, -1);
}

/** Return the hint row painted under the window. */
export function hintRow(view: Layout): Row {
	return view.rows[view.rows.length - 1];
}

/** Return the language tag of the first code fence, if any. */
export function fenceLang(markdown: string): string | undefined {
	return /^[ \t]*(?:```|~~~)[ \t]*([^\s`~]+)/m.exec(markdown)?.[1];
}

/** Lines the code column spends on its header. */
const CODE_HEADER_LINES = 1;

interface Extent {
	lines: number;
	columns: number;
}

/** Keep the preview's offsets while it shows the same markdown, each clamped so the column stays full; start a new preview at its top left. */
function previewWindow(
	markdown: string,
	code: { lines: number; widest: number },
	room: Extent,
	last: PreviewWindow | undefined,
): PreviewWindow {
	const lang = fenceLang(markdown);
	const same = last?.markdown === markdown ? last : undefined;
	const offset = Math.max(0, Math.min(same?.offset ?? 0, code.lines - (room.lines - CODE_HEADER_LINES)));
	const column = Math.max(0, Math.min(same?.column ?? 0, code.widest - room.columns));
	const window: PreviewWindow = { markdown, offset, column };
	return lang === undefined ? window : { ...window, lang };
}

/**
 * Lay out the form. `width` and `rows` are the terminal size the form gets,
 * `measure` returns a row's painted height at a width, and `offsets` are the
 * option window and preview column from the previous layout. Pass
 * `followCursor` false right after a scroll key so the option window stays where
 * the user scrolled it.
 */
export function layout(
	state: FormState,
	width: number,
	rows: number,
	measure: Measure,
	offsets: Offsets,
	followCursor = true,
): Layout {
	const tabs = isBatch(state) ? tabsOf(state) : [];
	const preview = columnPreview(state, width);
	const columns = columnWidths(width);
	const bodyWidth = preview === undefined ? width : columns.left;
	const body = inReview(state) ? reviewRows(state) : questionRows(state, preview === undefined);
	const hint: Row = { kind: "hint", text: hintText(state, preview !== undefined) };
	const budget = Math.max(1, rows - measure.height(hint, width) - (tabs.length > 0 ? TAB_STRIP_LINES : 0));
	const heights = body.map((row) => measure.height(row, bodyWidth));
	const windowOffset = chooseOffset(state, body, heights, budget, offsets.window, followCursor);
	const view: Layout = { tabs, rows: [...body, hint], windowOffset, budget };
	if (preview === undefined) return view;
	const lines = measure.height({ kind: "code", markdown: preview }, columns.right);
	const widest = measure.codeWidth(preview);
	return { ...view, preview: previewWindow(preview, { lines, widest }, { lines: budget, columns: columns.right }, offsets.preview) };
}

/** Report whether a key scrolls the form rather than reaching the form state. */
export function isScrollKey(key: KeyName): boolean {
	return SCROLL_KEYS[key] !== undefined;
}

/**
 * Return the offsets after a scroll key: PgUp/PgDn move a window, shift+up and
 * shift+down move one line, shift+left and shift+right pan the preview column
 * sideways. Vertical keys scroll the preview column when the layout has one,
 * else the option window; panning needs a preview column. The next layout
 * clamps them. Any other key leaves the offsets as they are.
 */
export function scrolledOffsets(view: Layout, key: KeyName): Offsets {
	const scroll = SCROLL_KEYS[key];
	const current: Offsets = { window: view.windowOffset, preview: view.preview };
	if (!scroll) return current;
	if (scroll.axis === "columns") {
		if (!view.preview) return current;
		const column = Math.max(0, view.preview.column + scroll.direction * PAN_STEP);
		return { ...current, preview: { ...view.preview, column } };
	}
	const lines = scroll.direction * (scroll.page ? view.budget : 1);
	if (!view.preview) return { window: Math.max(0, view.windowOffset + lines) };
	return { ...current, preview: { ...view.preview, offset: Math.max(0, view.preview.offset + lines) } };
}
