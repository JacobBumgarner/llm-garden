import assert from "node:assert/strict";
import { test } from "node:test";
import { columnRows, columnWidths, fenceLang, formRows, hintRow, type Layout, layout, type Measure, type Row, scrolledOffsets } from "../extensions/layout.ts";
import { step } from "../extensions/state.ts";
import type { FormState } from "../extensions/types.ts";
import { batch, form, opts, press } from "./helpers.ts";

/** A width under the preview column threshold, so previews render inline. */
const NARROW = 80;
/** A width over the preview column threshold. */
const WIDE = 120;
const PREVIEW_HEIGHT = 5;
const CODE_WIDTH = 100;
/** Build a Measure from a height function; every preview's code is CODE_WIDTH characters wide. */
const sized = (height: (row: Row) => number): Measure => ({ height, codeWidth: () => CODE_WIDTH });
const measureHeight = (row: Row) => (row.kind === "preview" || row.kind === "code" ? PREVIEW_HEIGHT : 1);
const measure = sized(measureHeight);

/** Measure rows as a terminal of the given width would: the hint wraps, the rest is one line. */
const measureAt = (width: number) =>
	sized((row: Row) => (row.kind === "hint" ? Math.ceil(row.text.length / width) : measureHeight(row)));

const kinds = (rows: Row[]) => rows.map((row) => row.kind);
const options = (rows: Row[]) => rows.filter((row) => row.kind === "option");
const highlightedIndex = (rows: Row[]) => rows.findIndex((row) => row.kind === "option" && row.highlighted);

/** Return the first line of each row, painting with the given measure. */
function firstLines(view: Layout, by: (row: Row) => number = measureHeight): number[] {
	const starts: number[] = [];
	let line = 0;
	for (const row of columnRows(view)) {
		starts.push(line);
		line += by(row);
	}
	return starts;
}

/** Report whether a row's first line falls inside the window. */
function visible(view: Layout, index: number, by: (row: Row) => number = measureHeight): boolean {
	const line = firstLines(view, by)[index];
	return line >= view.windowOffset && line < view.windowOffset + view.budget;
}

test("a single question has no tab strip at any width", () => {
	const s = form([{ id: "a", question: "A?", options: opts("x") }]);
	for (const width of [80, 160]) assert.deepEqual(layout(s, width, 40, measureAt(width), { window: 0 }).tabs, []);
});

test("a batch has a tab strip with one tab per question at 80 and 160 columns", () => {
	for (const width of [80, 160]) {
		const view = layout(batch(), width, 40, measureAt(width), { window: 0 });
		assert.deepEqual(
			view.tabs.map((tab) => [tab.label, tab.current]),
			[
				["A", true],
				["B", false],
				["C", false],
				["Send", false],
			],
		);
	}
});

test("a narrow terminal gives the column fewer lines because the hint wraps", () => {
	assert.ok(layout(batch(), 40, 40, measureAt(40), { window: 0 }).budget < layout(batch(), 160, 40, measureAt(160), { window: 0 }).budget);
});

test("a question lays out question, context, options in order, then the hint", () => {
	const s = form([{ id: "a", question: "A?", context: "ctx", options: opts("x", "y") }]);
	const view = layout(s, NARROW, 40, measure, { window: 0 });
	assert.deepEqual(kinds(view.rows), ["question", "context", "spacer", "option", "option", "other", "hint"]);
	assert.match((view.rows.at(-1) as { text: string }).text, /ctrl\+n note/);
});

test("the recommended option comes first, marked, with its reason", () => {
	const s = form([
		{
			id: "a",
			question: "A?",
			options: [{ label: "x" }, { label: "y", recommended: "fits" }],
		},
	]);
	const [first, second] = options(layout(s, NARROW, 40, measure, { window: 0 }).rows);
	assert.deepEqual(
		{ label: first.kind === "option" && first.label, recommended: first.kind === "option" && first.recommended },
		{ label: "y", recommended: true },
	);
	assert.equal(first.kind === "option" && first.reason, "fits");
	assert.equal(second.kind === "option" && second.recommended, false);
	assert.equal(second.kind === "option" && second.reason, undefined);
});

test("only the highlighted option's preview is present, directly under it", () => {
	let s = form([
		{
			id: "a",
			question: "A?",
			options: [
				{ label: "x", preview: "px" },
				{ label: "y", preview: "py" },
				{ label: "z" },
			],
		},
	]);
	let rows = layout(s, NARROW, 40, measure, { window: 0 }).rows;
	assert.deepEqual(kinds(rows), ["question", "spacer", "option", "preview", "option", "option", "other", "hint"]);
	assert.deepEqual(rows[3], { kind: "preview", markdown: "px" });
	s = press(s, "down");
	rows = layout(s, NARROW, 40, measure, { window: 0 }).rows;
	assert.deepEqual(kinds(rows), ["question", "spacer", "option", "option", "preview", "option", "other", "hint"]);
	assert.deepEqual(rows[4], { kind: "preview", markdown: "py" });
	s = press(s, "down");
	assert.equal(layout(s, NARROW, 40, measure, { window: 0 }).rows.filter((row) => row.kind === "preview").length, 0);
});

test("the text editor row follows the options in text mode and is the body of a zero-option question", () => {
	const typed = press(form([{ id: "a", question: "A?", options: opts("x") }]), "printable");
	assert.deepEqual(kinds(layout(typed, NARROW, 40, measure, { window: 0 }).rows), ["question", "spacer", "option", "other", "editor", "hint"]);
	const free = form([{ id: "a", question: "A?" }]);
	assert.deepEqual(layout(free, NARROW, 40, measure, { window: 0 }).rows.slice(0, 3), [
		{ kind: "question", text: "A?" },
		{ kind: "spacer" },
		{ kind: "editor", which: "text" },
	]);
	const noting = press(form([{ id: "a", question: "A?", options: opts("x") }]), "note");
	assert.deepEqual(layout(noting, NARROW, 40, measure, { window: 0 }).rows[4], { kind: "editor", which: "note" });
	assert.deepEqual(layout(noting, NARROW, 40, measure, { window: 0 }).rows[3], { kind: "other", at: 1, number: 2, highlighted: false });
});

test("the window follows the cursor past the bottom and back to the top", () => {
	const labels = Array.from({ length: 12 }, (_, i) => `o${i}`);
	let s = form([{ id: "a", question: "A?", options: opts(...labels) }]);
	const screen = 6;
	const visibleRows = screen - 1; // the hint row takes one line
	const totalRows = 14; // question row, spacer, and 12 options
	let view = layout(s, NARROW, screen, measure, { window: 0 });
	assert.equal(view.windowOffset, 0);
	for (let i = 0; i < 11; i++) {
		s = press(s, "down");
		view = layout(s, NARROW, screen, measure, { window: view.windowOffset });
		assert.ok(visible(view, highlightedIndex(view.rows)), `cursor ${i + 1} visible`);
	}
	assert.equal(view.windowOffset, totalRows - visibleRows);
	assert.equal(view.budget, visibleRows);
	s = press(s, "up");
	view = layout(s, NARROW, screen, measure, { window: view.windowOffset });
	assert.equal(view.windowOffset, totalRows - visibleRows, "moving up inside the window does not scroll");
	for (let i = 0; i < 10; i++) s = press(s, "up");
	view = layout(s, NARROW, screen, measure, { window: view.windowOffset });
	assert.equal(view.windowOffset, 2);
	assert.equal(highlightedIndex(view.rows), 2);
});

test("the window scrolls to keep a highlighted option and its tall preview in view", () => {
	let s = form([{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y", preview: "big" }] }]);
	s = press(s, "down");
	const view = layout(s, NARROW, 7, measure, { window: 0 });
	assert.equal(view.windowOffset, 3);
	assert.equal(view.budget, 6);
});

test("an offset past the end is clamped to the last offset that fills the screen", () => {
	const labels = Array.from({ length: 12 }, (_, i) => `o${i}`);
	const s = form([{ id: "a", question: "A?", options: opts(...labels) }]);
	const view = layout(s, NARROW, 6, measure, { window: 50 }, false);
	assert.equal(view.windowOffset, 10);
	assert.equal(layout(s, NARROW, 6, measure, { window: 3 }, false).windowOffset, 3, "a paged offset holds without follow");
});

test("tab marks show unanswered, answered, flagged, and noted", () => {
	let s = form([
		{ id: "a", question: "A?", options: opts("a1") },
		{ id: "b", question: "B?", options: opts("b1") },
		{ id: "c", question: "C?", options: opts("c1") },
		{ id: "d", question: "D?", options: opts("d1") },
	]);
	s = press(s, "enter", "clarify", "note");
	s = step(s, { type: "noteDraft", text: "hm" });
	s = press(s, "enter");
	const marks = (state: FormState) => layout(state, NARROW, 40, measure, { window: 0 }).tabs.map((tab) => [tab.label, tab.mark, tab.current]);
	assert.deepEqual(marks(s), [
		["A", "answered", false],
		["B", "flagged", false],
		["C", "unanswered", true],
		["D", "unanswered", false],
		["Send", undefined, false],
	]);
	assert.deepEqual(marks(press(s, "enter"))[2], ["C", "noted", false], "the note shows in the strip once the question is answered");
});

test("review lists every question with a summary and a send row enabled only when all are answered", () => {
	let s = form([
		{ id: "a", question: "A?", options: opts("a1", "a2") },
		{ id: "b", question: "B?", options: opts("b1") },
		{ id: "c", question: "C?" },
	]);
	s = press(s, "down", "enter", "clarify");
	s = step(s, { type: "draft", text: "line one\nline two" });
	s = press(s, "enter");
	assert.equal(s.current, 3);
	s = { ...s, notes: new Map([["b", "why"]]) };
	let rows = layout(s, NARROW, 40, measure, { window: 0 }).rows;
	assert.deepEqual(kinds(rows), ["question", "spacer", "review", "review", "review", "spacer", "send", "hint"]);
	assert.deepEqual(
		rows.filter((row) => row.kind === "review").map((row) => row.kind === "review" && [row.id, row.summary, row.highlighted]),
		[
			["a", "a2", false],
			["b", "needs clarification + note", false],
			["c", "line one", false],
		],
	);
	assert.deepEqual(rows[6], { kind: "send", at: 3, enabled: true, highlighted: true }, "review opens on Send when all are answered");
	const answers = new Map(s.answers);
	answers.delete("c");
	rows = layout({ ...s, answers, cursor: 3 }, NARROW, 40, measure, { window: 0 }).rows;
	assert.deepEqual(rows[6], { kind: "send", at: 3, enabled: false, highlighted: true });
	assert.equal(rows[4].kind === "review" && rows[4].summary, "unanswered");
});

test("a tab strip and its blank line cost the window two lines", () => {
	assert.equal(layout(batch(), NARROW, 10, measure, { window: 0 }).budget, 7);
	assert.equal(layout(form([{ id: "a", question: "A?", options: opts("x") }]), NARROW, 10, measure, { window: 0 }).budget, 9);
});

test("paging moves the window by its own size and never below the top", () => {
	const labels = Array.from({ length: 20 }, (_, i) => `o${i}`);
	const s = form([{ id: "a", question: "A?", options: opts(...labels) }]);
	const top = layout(s, NARROW, 6, measure, { window: 0 });
	assert.equal(scrolledOffsets(top, "pageDown").window, 5);
	assert.equal(scrolledOffsets(top, "pageUp").window, 0);
	assert.equal(layout(s, NARROW, 6, measure, scrolledOffsets(top, "pageDown"), false).windowOffset, 5);
});

const TALL_PREVIEW = 20;
const tallHeight = (row: Row) => (row.kind === "preview" || row.kind === "code" ? TALL_PREVIEW : 1);
const tall = sized(tallHeight);
/** Screen rows that leave a 15-line budget for a single question: 15 for the column, 1 for the hint. */
const TALL_SCREEN = 16;

const optionLine = (view: Layout, label: string) =>
	firstLines(view, tallHeight)[view.rows.findIndex((row) => row.kind === "option" && row.label === label)];

test("a 20-line preview between two options leaves the next option reachable by arrowing down", () => {
	let s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "big" }, { label: "y" }] }]);
	let view = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	assert.equal(view.budget, 15);
	assert.equal(view.windowOffset, 0);
	assert.ok(visible(view, 1, tallHeight), "option 1 visible with the start of its preview");
	s = press(s, "down");
	view = layout(s, NARROW, TALL_SCREEN, tall, { window: view.windowOffset });
	const line = optionLine(view, "y");
	assert.ok(line >= view.windowOffset && line < view.windowOffset + view.budget, "option 2 visible");
});

test("arrowing off an option whose 20-line preview overflows reaches the option after it", () => {
	let s = form([{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y", preview: "big" }, { label: "z" }] }]);
	s = press(s, "down");
	let view = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	assert.equal(view.windowOffset, 0, "the question stays on screen while the option and half a window of preview fit");
	assert.ok(visible(view, 2, tallHeight), "option 2 visible with its preview below");
	s = press(s, "down");
	view = layout(s, NARROW, TALL_SCREEN, tall, { window: view.windowOffset });
	const line = optionLine(view, "z");
	assert.ok(line >= view.windowOffset && line < view.windowOffset + view.budget, "option 3 visible");
});

test("PgDn then PgUp move the window by lines and return to where it was", () => {
	const s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "big" }, { label: "y" }] }]);
	const top = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	const down = layout(s, NARROW, TALL_SCREEN, tall, scrolledOffsets(top, "pageDown"), false);
	const totalLines = 1 + 1 + 1 + TALL_PREVIEW + 1 + 1;
	assert.equal(down.windowOffset, totalLines - down.budget, "clamped to the last full window");
	assert.ok(down.windowOffset > 0 && down.windowOffset < top.budget, "moved by lines, not whole rows");
	const up = layout(s, NARROW, TALL_SCREEN, tall, scrolledOffsets(down, "pageUp"), false);
	assert.equal(up.windowOffset, top.windowOffset);
});

test("the window keeps an open editor's whole box on screen below a tall preview", () => {
	let s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "big" }, { label: "y" }] }]);
	s = press(s, "printable");
	const editorHeight = 3;
	const by = (row: Row) => (row.kind === "editor" ? editorHeight : tallHeight(row));
	const view = layout(s, NARROW, TALL_SCREEN, sized(by), { window: 0 });
	const editor = view.rows.findIndex((row) => row.kind === "editor");
	const first = firstLines(view, by)[editor];
	assert.ok(first >= view.windowOffset && first + editorHeight <= view.windowOffset + view.budget);
});

test("a highlighted option at the bottom of the window scrolls up to show half a window of its tall preview", () => {
	const labels = Array.from({ length: 14 }, (_, i) => ({ label: `o${i}` }));
	let s = form([{ id: "a", question: "A?", options: [...labels, { label: "last", preview: "big" }] }]);
	for (let i = 0; i < labels.length; i++) s = press(s, "down");
	const view = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	const line = optionLine(view, "last");
	assert.equal(view.windowOffset + view.budget, line + 1 + Math.ceil(view.budget / 2));
});

/** Two options with different 20-line previews and one without, under a question. */
const previewed = () =>
	form([
		{
			id: "a",
			question: "A?",
			options: [{ label: "x", preview: "px" }, { label: "y", preview: "py" }, { label: "z" }],
		},
	]);

test("a previewed highlighted option gets a preview column at 120 columns and none at 80", () => {
	const s = previewed();
	assert.deepEqual(layout(s, WIDE, TALL_SCREEN, tall, { window: 0 }).preview, { markdown: "px", offset: 0, column: 0 });
	assert.equal(layout(s, NARROW, TALL_SCREEN, tall, { window: 0 }).preview, undefined);
});

test("the option column has no preview row while the preview has its own column", () => {
	const view = layout(previewed(), WIDE, TALL_SCREEN, tall, { window: 0 });
	assert.deepEqual(kinds(view.rows), ["question", "spacer", "option", "option", "option", "other", "hint"]);
	assert.match((hintRow(view) as { text: string }).text, /shift\+arrows scroll code/);
});

test("the preview column and the option column share one budget", () => {
	const view = layout(previewed(), WIDE, TALL_SCREEN, tall, { window: 0 });
	assert.equal(view.budget, TALL_SCREEN - 1);
});

test("PgDn moves the preview offset by a window and leaves the option window alone", () => {
	const s = previewed();
	const top = layout(s, WIDE, TALL_SCREEN, tall, { window: 0 });
	const down = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(top, "pageDown"), false);
	assert.equal(down.preview?.offset, TALL_PREVIEW - (top.budget - 1), "clamped to the last full window under the one-line header");
	assert.equal(down.windowOffset, top.windowOffset);
	const up = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(down, "pageUp"), false);
	assert.equal(up.preview?.offset, 0);
});

test("the preview column follows the cursor: dropped for an option without one, reset for a different one", () => {
	let s = previewed();
	const top = layout(s, WIDE, TALL_SCREEN, tall, { window: 0 });
	const scrolled = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(top, "pageDown"), false);
	assert.ok((scrolled.preview?.offset ?? 0) > 0);
	s = press(s, "down");
	const next = layout(s, WIDE, TALL_SCREEN, tall, { window: scrolled.windowOffset, preview: scrolled.preview });
	assert.deepEqual(next.preview, { markdown: "py", offset: 0, column: 0 });
	s = press(s, "down");
	const plain = layout(s, WIDE, TALL_SCREEN, tall, { window: next.windowOffset, preview: next.preview });
	assert.equal(plain.preview, undefined);
	assert.equal(plain.rows.filter((row) => row.kind === "preview").length, 0);
});

test("review has no preview column at any width", () => {
	let s = form([
		{ id: "a", question: "A?", options: [{ label: "x", preview: "px" }] },
		{ id: "b", question: "B?", options: opts("y") },
	]);
	s = press(s, "enter", "enter");
	assert.equal(s.current, 2);
	assert.equal(layout(s, WIDE, TALL_SCREEN, tall, { window: 0 }).preview, undefined);
});

test("shift+down and shift+up move the preview column one line and leave the option window alone", () => {
	const s = previewed();
	const top = layout(s, WIDE, TALL_SCREEN, tall, { window: 0 });
	const down = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(top, "shift+down"), false);
	assert.equal(down.preview?.offset, 1);
	assert.equal(down.windowOffset, top.windowOffset);
	const up = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(down, "shift+up"), false);
	assert.equal(up.preview?.offset, 0);
});

test("shift+down moves the option window one line when there is no preview column", () => {
	const s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "big" }, { label: "y" }] }]);
	const top = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	const down = layout(s, NARROW, TALL_SCREEN, tall, scrolledOffsets(top, "shift+down"), false);
	assert.equal(down.windowOffset, top.windowOffset + 1);
});

test("a key that does not scroll leaves the offsets alone", () => {
	const top = layout(previewed(), WIDE, TALL_SCREEN, tall, { window: 0 });
	assert.deepEqual(scrolledOffsets(top, "down"), { window: top.windowOffset, preview: top.preview });
});

test("a 40-row terminal gives a batch a column budget that makes a 22-line form", () => {
	const rules = 2;
	const strip = 2;
	const hint = 1;
	const view = layout(batch(), WIDE, formRows(40), measure, { window: 0 });
	assert.equal(rules + strip + view.budget + hint, 22);
});

test("a short terminal still gets a 12-line form, and never more than pi leaves free", () => {
	assert.equal(formRows(20), 12 - 2);
	assert.equal(formRows(10), 10 - 2 - 2);
	assert.equal(formRows(80), 44 - 2);
});

test("fenceLang reads the first fence's language and the preview carries it", () => {
	assert.equal(fenceLang("```typescript\nconst a = 1;\n```"), "typescript");
	assert.equal(fenceLang("text\n\n~~~py\nx\n~~~"), "py");
	assert.equal(fenceLang("```\nplain\n```"), undefined);
	assert.equal(fenceLang("no code"), undefined);
});

test("pan clamps to the widest code line minus the column width", () => {
	const s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "px" }, { label: "y" }] }]);
	let view = layout(s, WIDE, TALL_SCREEN, tall, { window: 0 });
	for (let i = 0; i < 40; i++) view = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(view, "shift+right"), false);
	const { right } = columnWidths(WIDE);
	assert.equal(view.preview?.column, CODE_WIDTH - right);
	const short = sized(tallHeight);
	short.codeWidth = () => 10;
	assert.equal(layout(s, WIDE, TALL_SCREEN, short, scrolledOffsets(view, "shift+right"), false).preview?.column, 0);
});

test("shift+right and shift+left pan the preview column by a step, never past the left edge, and need a preview column", () => {
	const s = form([{ id: "a", question: "A?", options: [{ label: "x", preview: "px" }, { label: "y" }] }]);
	const top = layout(s, WIDE, TALL_SCREEN, tall, { window: 0 });
	const right = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(top, "shift+right"), false);
	assert.equal(right.preview?.column, 8);
	assert.equal(right.windowOffset, top.windowOffset);
	const back = layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(right, "shift+left"), false);
	assert.equal(back.preview?.column, 0);
	assert.equal(layout(s, WIDE, TALL_SCREEN, tall, scrolledOffsets(back, "shift+left"), false).preview?.column, 0);
	const narrow = layout(s, NARROW, TALL_SCREEN, tall, { window: 0 });
	assert.deepEqual(scrolledOffsets(narrow, "shift+right"), { window: narrow.windowOffset, preview: undefined });
});

test("a saved note shows under the options of its question while the note editor is closed", () => {
	let s = press(press(batch(), "note"), "printable");
	s = step(s, { type: "noteDraft", text: "remember the deploy script" });
	s = press(s, "enter");
	const rows = layout(s, NARROW, 40, measure, { window: 0 }).rows;
	const at = rows.findIndex((row) => row.kind === "note");
	assert.deepEqual(rows[at], { kind: "note", text: "remember the deploy script" });
	assert.equal(rows[at - 1]?.kind, "spacer");
	assert.equal(rows[at + 1]?.kind, "hint", "the note is the last body row");
	const editing = layout(press(s, "note"), NARROW, 40, measure, { window: 0 }).rows;
	assert.equal(editing.some((row) => row.kind === "note"), false, "the editor replaces the note while open");
});
