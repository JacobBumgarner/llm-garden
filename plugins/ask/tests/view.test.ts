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

/** Everything the form wrote to the terminal; copies arrive here as OSC 52. */
const written: string[] = [];
const tui: TUI = { terminal: { rows: ROWS, columns: 160, write: (data) => written.push(data) }, requestRender() {} };

/** Decode the text of the last OSC 52 copy. */
function lastCopy(): string {
	const match = /\x1b\]52;c;([^\x07]*)\x07/.exec(written[written.length - 1] ?? "");
	assert.ok(match, "something was copied");
	return Buffer.from(match[1], "base64").toString("utf8");
}
const rgb = (r: number, g: number, b: number): Color => ({ kind: "rgb", r, g, b });
const theme: Theme = {
	colors: { accent: rgb(0, 0, 200), text: rgb(200, 200, 200) },
	style: (t) => t,
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	underline: (t) => `_${t}_`,
	inverse: (t) => `[${t}]`,
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
				{ label: "Zustand", recommended: "Small.", detail: "Loose.", preview: code },
				{ label: "Redux", detail: "Heavy." },
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

/** A mouse event of any type at a point; `mouse("press", x, y)`. */
function mouse(type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent {
	return { ...click(x, y), type, button: type === "move" ? "none" : "left" };
}

test("the wheel over the option column scrolls the options, not the code", () => {
	const long = normalize({
		questions: [
			{
				id: "q",
				question: "Which?",
				context: Array.from({ length: 40 }, (_, i) => `context line ${i}`).join("\n"),
				options: [{ label: "a", preview: code }, { label: "b" }],
			},
		],
	});
	const form = new AskForm(tui, theme, long, () => {});
	form.focused = true;
	let lines = form.render(160);
	assert.match(lines[1], /^context line 23/, "the window opens on the highlighted option, with the question above it off screen");
	form.handleMouse({ ...wheel(-2), x: 10 });
	lines = form.render(160);
	assert.match(lines.join("\n"), /lines 1–/, "the code stayed at its top");
	assert.match(lines[1], /^context line 21/, "the option column moved up two lines");
	form.handleMouse({ ...wheel(2), x: 10 });
	assert.match(form.render(160)[1], /^context line 23/, "and wheels back");
	form.handleMouse({ ...wheel(2), x: 120 });
	lines = form.render(160);
	assert.match(lines[1], /^context line 23/, "a wheel over the code leaves the options alone");
	assert.match(lines.join("\n"), /lines 3–/, "and scrolls the code two lines");
});

test("clicks and hovers in the code column reach no option row", () => {
	const { form } = mount(accented);
	let lines = form.render(160);
	const redux = lineOf(lines, /2\. Redux/);
	form.handleMouse(mouse("move", 120, redux));
	lines = form.render(160);
	assert.match(lines[redux], /^  2\. Redux/, "no hover mark from the code column");
	form.handleMouse(mouse("click", 120, redux));
	assert.match(form.render(160).join("\n"), /Which store\?/, "the click chose nothing");
});

test("dragging over the code column highlights only that column and copies the covered code on release", () => {
	const { form } = mount();
	let lines = form.render(160);
	const header = lineOf(lines, /lines 1–/);
	const codeX = lines[header + 1].indexOf("const line0");
	assert.ok(codeX > 80, "the code sits in the right column");
	assert.deepEqual(form.handleMouse(mouse("press", codeX, header + 1)), { capture: true, focus: true });
	assert.deepEqual(form.handleMouse(mouse("drag", codeX + 10, header + 2)), { handled: true, render: true });
	lines = form.render(160);
	assert.match(lines[header + 1], /^.{80}.{3}\[const line0 = x+/, "the first line is inverse from the press on");
	assert.match(lines[header + 2], /^.{80}.{3}\[const line1\]/, "the second line is inverse from its start through the pointer");
	assert.doesNotMatch(lines[header + 1].slice(0, 80), /\[/, "the option column is untouched");
	form.handleMouse(mouse("release", codeX + 10, header + 2));
	assert.equal(lastCopy(), `const line0 = ${"x".repeat(100)};\nconst line1`);
	lines = form.render(160);
	assert.match(lines[header + 1], /\[const line0/, "the highlight stays after the release, to rest the eyes on");
	assert.match(lines[header], /copied/, "the header reports the copy");
	assert.deepEqual(form.handleMouse(mouse("press", 120, header)), { handled: true, render: true }, "a press anywhere clears it");
	assert.doesNotMatch(form.render(160)[header + 1], /\[/);
});

test("a drag held below the code column keeps scrolling it and growing the selection", async () => {
	const { form } = mount();
	let lines = form.render(160);
	const header = lineOf(lines, /lines 1–/);
	const codeX = lines[header + 1].indexOf("const line0");
	written.length = 0;
	form.handleMouse(mouse("press", codeX, header + 1));
	form.handleMouse(mouse("drag", codeX + 5, ROWS + 20));
	await new Promise((r) => setTimeout(r, 260));
	lines = form.render(160);
	assert.doesNotMatch(lines.join("\n"), /lines 1–/, "the code column scrolled");
	form.handleMouse(mouse("release", codeX + 5, ROWS + 20));
	form.dispose();
	const copied = lastCopy();
	const reach = Math.max(...[...copied.matchAll(/const line(\d+)/g)].map((m) => Number(m[1])));
	assert.ok(reach >= 5, `the copy reaches line${reach}, past the first screen`);
});

test("dragging over the option column highlights and copies only that column, and a still press copies nothing", () => {
	const { form } = mount();
	let lines = form.render(160);
	const context = lineOf(lines, /^Some context\./);
	assert.deepEqual(form.handleMouse(mouse("press", 5, context)), { capture: true, focus: true });
	form.handleMouse(mouse("drag", 2, context + 2));
	lines = form.render(160);
	assert.match(lines[context], /^Some \[context\.\s+/, "the context line is inverse from the press to the column's end");
	assert.match(lines[context + 2], /^\[❯ 1\]\. Zustand/, "the option line is inverse through the pointer");
	assert.doesNotMatch(lines[context].slice(82), /\[/, "the code column is untouched");
	written.length = 0;
	form.handleMouse(mouse("release", 2, context + 2));
	assert.equal(lastCopy(), "context.\n\n❯ 1");
	assert.match(form.render(160)[context], /\[/, "the highlight stays after the release");
	press(form, "down");
	assert.doesNotMatch(form.render(160)[context], /\[/, "a key clears it");
	written.length = 0;
	form.handleMouse(mouse("press", 5, context));
	form.handleMouse(mouse("release", 5, context));
	assert.equal(written.length, 0, "a press without a drag copies nothing, leaving the click to pi");
	assert.doesNotMatch(form.render(160)[context], /\[/, "and leaves no highlight");
});

test("a double click copies the word under it in the code column", () => {
	const { form } = mount();
	const lines = form.render(160);
	const header = lineOf(lines, /lines 1–/);
	const codeX = lines[header + 1].indexOf("const line0");
	written.length = 0;
	assert.deepEqual(form.handleMouse({ ...mouse("click", codeX + 2, header + 2), clickCount: 2 } as TuiMouseEvent), { handled: true, render: true, focus: true });
	assert.equal(lastCopy(), "const");
});

test("a triple click copies the whole line under it in either column", () => {
	const { form } = mount();
	const lines = form.render(160);
	const header = lineOf(lines, /lines 1–/);
	const codeX = lines[header + 1].indexOf("const line0");
	written.length = 0;
	assert.deepEqual(form.handleMouse({ ...mouse("click", codeX + 4, header + 2), clickCount: 3 } as TuiMouseEvent), { handled: true, render: true, focus: true });
	assert.equal(lastCopy(), `const line1 = ${"x".repeat(100)};`);
	assert.match(form.render(160)[header], /copied/);
	const context = lineOf(lines, /^Some context\./);
	form.handleMouse({ ...mouse("click", 3, context), clickCount: 3 } as TuiMouseEvent);
	assert.equal(lastCopy(), "Some context.");
});

test("a press on the code header, the rule, or without a code column is not a selection", () => {
	const { form } = mount();
	const lines = form.render(160);
	const header = lineOf(lines, /lines 1–/);
	assert.equal(form.handleMouse(mouse("press", 81, header + 1)), undefined, "the gutter is neither column");
	assert.equal(form.handleMouse(mouse("press", 120, header)), undefined, "the header is not code");
	press(form, "2");
	form.render(160);
	assert.equal(form.handleMouse(mouse("press", 120, header + 1)), undefined, "no code column, no selection");
});

test("ctrl+b copies the highlighted option's whole code block", () => {
	const { form } = mount();
	form.render(160);
	written.length = 0;
	press(form, "down", "ctrl+b");
	assert.equal(written.length, 0, "an option without code copies nothing");
	press(form, "up", "ctrl+b");
	const copied = lastCopy().split("\n");
	assert.equal(copied.length, 25);
	assert.equal(copied[0], `const line0 = ${"x".repeat(100)};`);
	assert.match(form.render(160).join("\n"), /copied/);
});
