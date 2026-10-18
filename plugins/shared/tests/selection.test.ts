import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { before, type Cell, cellAt as paintedCellAt, highlightSelection, ordered, type PaintedText, selectedText, TextSelection } from "../selection.ts";

const lines = ["abcdef", "ghijkl", "mnopqr"];
const mark = (s: string) => `[${s}]`;

function mouse(type: TuiMouseEvent["type"], x = 0, y = 0): TuiMouseEvent {
	return { type, x, y, button: "left" } as TuiMouseEvent;
}

/** One cell per column and row, clamped into the three test lines. */
function cellAt(x: number, y: number, clampEdges: boolean): Cell | undefined {
	const inside = x >= 0 && x < 6 && y >= 0 && y < 3;
	if (!clampEdges && !inside) return undefined;
	return { line: Math.min(Math.max(y, 0), 2), col: Math.min(Math.max(x, 0), 5) };
}

describe("before and ordered", () => {
	test("compare by line, then column", () => {
		assert.equal(before({ line: 0, col: 5 }, { line: 1, col: 0 }), true);
		assert.equal(before({ line: 1, col: 2 }, { line: 1, col: 3 }), true);
		assert.equal(before({ line: 1, col: 3 }, { line: 1, col: 3 }), false);
	});

	test("ordered swaps a backward selection", () => {
		const a = { line: 2, col: 1 };
		const b = { line: 0, col: 4 };
		assert.deepEqual(ordered({ anchor: a, focus: b }), [b, a]);
		assert.deepEqual(ordered({ anchor: b, focus: a }), [b, a]);
	});
});

describe("selectedText", () => {
	test("spans lines from the start column through the end column", () => {
		assert.equal(selectedText(lines, { anchor: { line: 0, col: 2 }, focus: { line: 2, col: 1 } }), "cdef\nghijkl\nmn");
	});

	test("reads a backward selection in reading order", () => {
		assert.equal(selectedText(lines, { anchor: { line: 1, col: 3 }, focus: { line: 1, col: 1 } }), "hij");
	});

	test("stops at the last line and trims trailing space", () => {
		assert.equal(selectedText(["ab   "], { anchor: { line: 0, col: 0 }, focus: { line: 4, col: 9 } }), "ab");
	});
});

describe("highlightSelection", () => {
	const sel = { anchor: { line: 0, col: 1 }, focus: { line: 1, col: 2 } };

	test("returns the text untouched with no selection or outside its lines", () => {
		assert.equal(highlightSelection("abcdef", 0, 6, undefined, mark), "abcdef");
		assert.equal(highlightSelection("mnopqr", 2, 6, sel, mark), "mnopqr");
	});

	test("marks from the start column on the first line", () => {
		assert.equal(highlightSelection("abcdef", 0, 6, sel, mark), "a[bcdef]");
	});

	test("marks through the end column on the last line", () => {
		assert.equal(highlightSelection("ghijkl", 1, 6, sel, mark), "[ghi]jkl");
	});

	test("pads a short line so the selection past its end shows", () => {
		assert.equal(highlightSelection("ab", 0, 6, sel, mark), "a[b    ]");
	});

	test("skips a span that starts past the width", () => {
		const far = { anchor: { line: 0, col: 9 }, focus: { line: 0, col: 12 } };
		assert.equal(highlightSelection("abcdef", 0, 6, far, mark), "abcdef");
	});
});

describe("TextSelection", () => {
	test("starts idle", () => {
		const s = new TextSelection();
		assert.equal(s.current, undefined);
		assert.equal(s.dragging, false);
	});

	test("press anchors a dragging selection and a missing cell leaves none", () => {
		const s = new TextSelection();
		s.press({ line: 1, col: 1 });
		assert.equal(s.dragging, true);
		assert.deepEqual(s.current, { anchor: { line: 1, col: 1 }, focus: { line: 1, col: 1 }, settled: false });
		s.press(undefined);
		assert.equal(s.current, undefined);
	});

	test("drag and move grow the focus, and clamp through the callback", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 0 });
		const drag = s.drag(mouse("drag", 3, 1), cellAt, lines);
		assert.deepEqual(drag, { result: { handled: true, render: true } });
		assert.deepEqual(s.current?.focus, { line: 1, col: 3 });
		s.drag(mouse("move", 99, 99), cellAt, lines);
		assert.deepEqual(s.current?.focus, { line: 2, col: 5 });
	});

	test("an event the callback cannot place keeps the focus", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 0 });
		s.drag(mouse("drag"), () => undefined, lines);
		assert.deepEqual(s.current?.focus, { line: 0, col: 0 });
	});

	test("release after a move settles and reports the text to copy", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 1 });
		s.drag(mouse("drag", 2, 1), cellAt, lines);
		const out = s.drag(mouse("release", 2, 1), cellAt, lines);
		assert.equal(out.copy, "bcdef\nghi");
		assert.deepEqual(out.result, { handled: true, render: true });
		assert.equal(s.current?.settled, true);
		assert.equal(s.dragging, false);
	});

	test("release without a move drops the selection and copies nothing", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 1 });
		const out = s.drag(mouse("release"), cellAt, lines);
		assert.equal(out.copy, undefined);
		assert.equal(s.current, undefined);
	});

	test("other events are handled without a render", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 1 });
		assert.deepEqual(s.drag(mouse("click"), cellAt, lines), { result: { handled: true } });
		assert.equal(s.dragging, true);
	});

	test("selectLine settles the whole line and returns it trimmed", () => {
		const s = new TextSelection();
		const text = s.selectLine(["ab  ", "xyz"], 0);
		assert.equal(text, "ab");
		assert.deepEqual(s.current, { anchor: { line: 0, col: 0 }, focus: { line: 0, col: 3 }, settled: true });
	});

	test("clear drops the selection", () => {
		const s = new TextSelection();
		s.press({ line: 0, col: 0 });
		s.clear();
		assert.equal(s.current, undefined);
	});
});

describe("cellAt", () => {
	const painted: PaintedText = { lines: ["abcdefgh", "ijklmnop", "qrstuvwx"], x: 2, y: 1, width: 4, height: 5, top: 1, pan: 3 };

	test("maps a point to a line and a column offset by the top and the pan", () => {
		assert.deepEqual(paintedCellAt(painted, 3, 1, false), { line: 1, col: 4 });
		assert.deepEqual(paintedCellAt(painted, 5, 2, false), { line: 2, col: 6 });
	});

	test("refuses a point outside the area and a blank row under the lines", () => {
		assert.equal(paintedCellAt(painted, 1, 1, false), undefined);
		assert.equal(paintedCellAt(painted, 6, 1, false), undefined);
		assert.equal(paintedCellAt(painted, 3, 0, false), undefined);
		assert.equal(paintedCellAt(painted, 3, 4, false), undefined, "row 3 of the area is past the last line");
	});

	test("snaps an outside point to the nearest cell when clamping", () => {
		assert.deepEqual(paintedCellAt(painted, 0, 0, true), { line: 1, col: 3 });
		assert.deepEqual(paintedCellAt(painted, 20, 20, true), { line: 2, col: 6 });
	});

	test("gives nothing for an empty body", () => {
		assert.equal(paintedCellAt({ ...painted, lines: [] }, 3, 1, true), undefined);
	});
});

describe("highlightSelection with a pan", () => {
	test("shifts the selection columns left by the pan", () => {
		const sel = { anchor: { line: 0, col: 4 }, focus: { line: 0, col: 5 } };
		assert.equal(highlightSelection("efgh", 0, 4, sel, mark, 3), "e[fg]h");
	});
});
