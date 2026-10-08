/**
 * Paints the form through the stubbed pi so every row kind and screen renders
 * without a terminal. Guards the view's members and imports, which the pure
 * layout tests never touch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize } from "../extensions/call.ts";
import type { AskResult } from "../extensions/types.ts";
import { AskForm } from "../extensions/view.ts";
import type { Theme } from "./stubs/pi-coding-agent.ts";
import type { Color, TUI, TuiMouseEvent } from "./stubs/pi-tui.ts";

const ROWS = 40;
const WIDTHS = [80, 160];

const tui: TUI = { terminal: { rows: ROWS, columns: 160 }, requestRender() {} };
const rgb = (r: number, g: number, b: number): Color => ({ kind: "rgb", r, g, b });
const theme: Theme = {
	colors: { accent: rgb(0, 0, 200), text: rgb(200, 200, 200) },
	style: (t) => t,
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	underline: (t) => `_${t}_`,
};
/** A theme that brackets accent text and braces styled text, for tests about what gets which color. */
const accented: Theme = {
	...theme,
	fg: (c, t) => (c === "accent" ? `<${t}>` : t),
	style: (t, options) => (typeof options.fg === "object" ? `{${options.fg.r},${options.fg.g},${options.fg.b}:${t}}` : t),
};

const code = ["```typescript", ...Array.from({ length: 25 }, (_, i) => `const line${i} = ${"x".repeat(100)};`), "```"].join("\n");

const questions = normalize({
	questions: [
		{
			id: "store",
			question: "Which store?",
			context: "Some context.",
			options: [
				{ label: "Zustand", recommended: "Small.", tradeoff: "Loose.", preview: code },
				{ label: "Redux", tradeoff: "Heavy." },
			],
		},
		{ id: "name", question: "Name?" },
		{ id: "flags", question: "Flags?", multi: true, options: [{ label: "a" }, { label: "b" }] },
	],
});

function mount(paint: Theme = theme): { form: AskForm; results: AskResult[] } {
	const results: AskResult[] = [];
	const form = new AskForm(tui, paint, questions, (result) => results.push(result));
	form.focused = true;
	return { form, results };
}

function press(form: AskForm, ...keys: string[]): void {
	for (const key of keys) form.handleInput(key);
}

/** Render at every width and check the frame: no line wider than the terminal, and never taller than the form's share of it. */
function paints(form: AskForm, label: string): Record<number, string[]> {
	const out: Record<number, string[]> = {};
	for (const width of WIDTHS) {
		const lines = form.render(width);
		assert.ok(lines.length > 0, `${label} at ${width}: paints something`);
		assert.ok(lines.length <= Math.ceil(ROWS * 0.55) + 2, `${label} at ${width}: ${lines.length} lines stays within the form's share`);
		for (const line of lines) assert.ok([...line].length <= width, `${label} at ${width}: line fits: ${JSON.stringify(line)}`);
		out[width] = lines;
	}
	return out;
}

test("the option list paints with a code column at 160 and inline at 80", () => {
	const { form } = mount();
	const painted = paints(form, "list");
	const wide = painted[160].join("\n");
	assert.match(wide, /typescript/, "the fence language heads the code column");
	assert.match(wide, /lines 1–\d+ of 25/, "the header shows the visible range");
	assert.match(wide, /›/, "a right rail marks cut-off code");
	assert.match(wide, /1\. Zustand \(Recommended\)/);
	assert.match(wide, /3\. Type your own answer…/);
	assert.doesNotMatch(wide, /```/, "fences are stripped");
	press(form, "shift+right", "shift+down");
	assert.match(form.render(160).join("\n"), /‹/, "a left rail marks a pan");
	assert.match(painted[80].join("\n"), /const line0/, "the preview renders inline when narrow");
});

test("text, note, multi, and review screens paint, and Send finishes", () => {
	const { form, results } = mount();
	press(form, "a");
	assert.match(paints(form, "text")[160].join("\n"), /› a/, "the typed character shows behind the prompt gutter");
	press(form, "escape", "ctrl+n");
	assert.match(paints(form, "note")[160].join("\n"), /※/);
	press(form, "escape", "enter", "enter");
	assert.match(paints(form, "free text")[160].join("\n"), /Name\?/, "Enter on the Other row reopens the draft, Enter again submits it");
	press(form, "x", "enter");
	const multi = paints(form, "multi")[160].join("\n");
	assert.match(multi, /1\. \[ \] a/);
	assert.match(multi, /\[ Next \]/);
	assert.match(multi, /\[ Send \]/);
	press(form, "space", "down", "down", "down", "enter");
	const review = paints(form, "review")[160].join("\n");
	assert.match(review, /Review your answers/);
	assert.match(review, /3\/3 answered/);
	press(form, "enter");
	assert.equal(results.length, 1);
	assert.equal(results[0].cancelled, false);
});

test("a digit on the list picks the option instead of typing it", () => {
	const { form } = mount();
	form.render(160);
	press(form, "2");
	const painted = form.render(160).join("\n");
	assert.match(painted, /Name\?/, "option 2 was chosen and the form advanced");
	assert.doesNotMatch(painted, /› 2/);
});

test("ctrl+c cancels from the list", () => {
	const { form, results } = mount();
	press(form, "ctrl+c");
	assert.deepEqual(results.map((r) => r.cancelled), [true]);
});

function click(x: number, y: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 160, height: 24, shift: false, alt: false, ctrl: false };
}

function wheel(delta: number): TuiMouseEvent {
	return { ...click(100, 5), type: "wheel", button: "none", wheelDelta: delta };
}

/** Return the index of the first painted line matching the pattern. */
function lineOf(lines: string[], pattern: RegExp): number {
	const index = lines.findIndex((line) => pattern.test(line));
	assert.notEqual(index, -1, `a line matches ${pattern}`);
	return index;
}

test("clicks pick options, open the Other row, switch tabs, and send; the wheel scrolls the code", () => {
	const { form, results } = mount();
	let lines = form.render(160);
	assert.match(lines[lineOf(lines, /lines 1–/)], /lines 1–/);
	form.handleMouse(wheel(3));
	lines = form.render(160);
	assert.match(lines.join("\n"), /lines 4–/, "three wheel notches scroll the code three lines");
	const strip = lineOf(lines, /Flags/);
	form.handleMouse(click(lines[strip].indexOf("Flags"), strip));
	lines = form.render(160);
	assert.match(lines.join("\n"), /Flags\?/, "clicking the Q3 tab opens it");
	form.handleMouse(click(5, lineOf(lines, /1\. \[ \] a/)));
	lines = form.render(160);
	assert.match(lines.join("\n"), /1\. \[x\] a/, "clicking a multi option toggles it");
	form.handleMouse(click(5, lineOf(lines, /\[ Next \]/)));
	lines = form.render(160);
	assert.match(lines.join("\n"), /Which store\?/, "Next commits and advances to the first unanswered question");
	form.handleMouse(click(5, lineOf(lines, /Type your own answer/)));
	lines = form.render(160);
	assert.match(lines.join("\n"), /›/, "clicking the Other row opens the editor");
	form.handleMouse(click(5, lineOf(lines, /2\. Redux/)));
	lines = form.render(160);
	assert.match(lines.join("\n"), /Name\?/, "clicking an option from the editor leaves it and chooses");
	press(form, "n", "enter");
	lines = form.render(160);
	assert.match(lines.join("\n"), /Review your answers/);
	form.handleMouse(click(5, lineOf(lines, /\[ Send \]/)));
	assert.equal(results.length, 1);
	assert.equal(results[0].cancelled, false);
});

test("hovering a row marks it with a dim pointer and hovering a tab underlines it, repainting only on change", () => {
	const { form } = mount(accented);
	let lines = form.render(160);
	const redux = lineOf(lines, /2\. Redux/);
	const move = (x: number, y: number): TuiMouseEvent => ({ ...click(x, y), type: "move", button: "none" });
	assert.deepEqual(form.handleMouse(move(5, redux)), { handled: true, render: true });
	assert.deepEqual(form.handleMouse(move(6, redux)), { handled: true, render: false }, "same target, no repaint");
	lines = form.render(160);
	assert.match(lines[redux], /^› 2\. \{100,100,200:Redux\}/, "the hovered label takes the accent mixed halfway toward the text color");
	assert.match(lines[lineOf(lines, /1\. <Zustand>/)], /^<❯ >1\. <Zustand>/, "the cursor row keeps its own pointer and color");
	const strip = lineOf(lines, /○ Name/);
	form.handleMouse(move(lines[strip].indexOf("Name"), strip));
	lines = form.render(160);
	assert.match(lines[strip], /_○ Name_/);
	assert.match(lines[redux], /^  2\. Redux/, "the row mark and color move away with the pointer");
});
