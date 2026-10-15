import assert from "node:assert/strict";
import { test } from "node:test";
import { createEscapeTimer, ESCAPE_WINDOW_MS } from "../extensions/escape.ts";

/** A timer on a scripted clock. `press(advance)` moves the clock forward by `advance` ms, then presses. */
function timer() {
	let time = 1000;
	const escape = createEscapeTimer(ESCAPE_WINDOW_MS, () => time);
	return {
		press(advance: number): boolean {
			time += advance;
			return escape.press();
		},
	};
}

test("a second press inside the window pairs with the first", () => {
	const t = timer();
	assert.equal(t.press(0), false);
	assert.equal(t.press(1000), true);
});

test("a press at the window edge pairs and one past it does not", () => {
	const edge = timer();
	edge.press(0);
	assert.equal(edge.press(ESCAPE_WINDOW_MS), true);
	const late = timer();
	late.press(0);
	assert.equal(late.press(ESCAPE_WINDOW_MS + 1), false);
});

test("a late press starts a fresh pair that a prompt press completes", () => {
	const t = timer();
	t.press(0);
	assert.equal(t.press(5000), false);
	assert.equal(t.press(200), true);
});

test("a third press after a pair starts fresh", () => {
	const t = timer();
	t.press(0);
	assert.equal(t.press(100), true);
	assert.equal(t.press(100), false);
	assert.equal(t.press(100), true);
});
