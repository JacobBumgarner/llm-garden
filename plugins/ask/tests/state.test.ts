import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResult, initialState, inReview, isAnswered, step } from "../extensions/state.ts";
import type { FormEvent, FormState, KeyName } from "../extensions/types.ts";
import { batch, form, opts, press } from "./helpers.ts";

function apply(state: FormState, ...events: FormEvent[]): FormState {
	return events.reduce(step, state);
}

/** Jump straight to review, bypassing the answers that normally lead there. */
function atReview(state: FormState): FormState {
	return { ...state, current: state.questions.length, cursor: 0 };
}

const key = (name: KeyName): FormEvent => ({ type: "key", key: name });
const draft = (text: string): FormEvent => ({ type: "draft", text });
const noteDraft = (text: string): FormEvent => ({ type: "noteDraft", text });
const single = () => form([{ id: "a", question: "A?", options: opts("x", "y") }]);

test("single question sends on Enter", () => {
	const s = press(single(), "down", "enter");
	assert.deepEqual(s.result, {
		answers: [{ id: "a", answer: { kind: "selected", indices: [1] } }],
		cancelled: false,
	});
});

test("batch auto-advances, wraps to an earlier unanswered question, and lands in review", () => {
	let s = batch();
	s = press(s, "right", "enter");
	assert.equal(s.current, 2);
	s = press(s, "enter");
	assert.equal(s.current, 0);
	s = press(s, "enter");
	assert.equal(s.current, 3);
	assert.equal(s.result, undefined);
});

test("multi toggles survive leaving and returning", () => {
	let s = form([
		{ id: "m", question: "M?", multi: true, options: opts("x", "y", "z") },
		{ id: "o", question: "O?", options: opts("p") },
	]);
	s = press(s, "space", "down", "down", "space", "right", "left");
	assert.deepEqual([...(s.checked.get("m") ?? [])].sort(), [0, 2]);
	s = press(s, "down", "down", "down", "down", "enter");
	assert.deepEqual(s.answers.get("m"), { kind: "selected", indices: [0, 2] });
});

test("multi: enter on an option toggles it like space, enter on the Next row commits, and Next is inert while empty", () => {
	const q = form([{ id: "m", question: "M?", multi: true, options: opts("x", "y") }]);
	const toggled = press(q, "down", "enter");
	assert.deepEqual([...toggled.checked.get("m")!], [1]);
	assert.deepEqual(toggled.answers.get("m"), { kind: "selected", indices: [1] }, "a checked box answers at once");
	const untoggled = press(toggled, "enter");
	assert.equal(untoggled.checked.get("m")!.size, 0);
	assert.equal(untoggled.answers.has("m"), false, "unchecking the last box removes the answer");
	const idle = press(untoggled, "down", "down", "enter");
	assert.equal(idle.cursor, 3);
	assert.equal(idle.result, undefined);
	const s = press(q, "space", "down", "down", "down", "enter");
	assert.deepEqual(s.result?.answers[0].answer, { kind: "selected", indices: [0] });
});

test("multi cursor reaches the Next row and space there does nothing", () => {
	const q = form([{ id: "m", question: "M?", multi: true, options: opts("x", "y") }]);
	const s = press(q, "down", "down", "down", "down", "space");
	assert.equal(s.cursor, 3);
	assert.equal(s.checked.get("m")?.size ?? 0, 0);
});

test("space in a single-select list is ignored", () => {
	const s = press(single(), "space");
	assert.equal(s.checked.size, 0);
	assert.equal(s.mode, "list");
});

test("printable enters text mode without setting the draft, a draft event sets it, Esc keeps it", () => {
	let s = press(batch(), "printable");
	assert.equal(s.mode, "text");
	assert.equal(s.drafts.has("a"), false);
	s = apply(s, draft("hello"));
	assert.equal(s.drafts.get("a"), "hello");
	s = press(s, "escape");
	assert.equal(s.mode, "list");
	assert.equal(s.drafts.get("a"), "hello");
	assert.equal(s.result, undefined);
});

test("enter in text mode commits the draft as a text answer and advances", () => {
	const s = press(apply(press(batch(), "printable"), draft("hi")), "enter");
	assert.deepEqual(s.answers.get("a"), { kind: "text", text: "hi" });
	assert.equal(s.current, 1);
	assert.equal(s.mode, "list");
});

test("ctrl+k sets clarify then clears it", () => {
	let s = press(batch(), "clarify");
	assert.deepEqual(s.answers.get("a"), { kind: "clarify" });
	assert.equal(s.current, 1);
	s = press(s, "left", "clarify");
	assert.equal(isAnswered(s, "a"), false);
});

test("a note on an unanswered question neither answers nor advances, and buildResult attaches it by id", () => {
	let s = press(batch(), "note");
	assert.equal(s.mode, "note");
	s = apply(s, noteDraft("careful"));
	s = press(s, "enter");
	assert.equal(s.mode, "list");
	assert.equal(s.current, 0);
	assert.equal(isAnswered(s, "a"), false);
	assert.equal(s.notes.get("a"), "careful");
	s = press(s, "enter");
	const result = buildResult(s, false);
	assert.deepEqual(result.answers[0], { id: "a", answer: { kind: "selected", indices: [0] }, note: "careful" });
	s = press(s, "left", "note");
	assert.equal(s.noteDraft, "careful");
});

test("a zero-option question opens in text mode and Esc cancels", () => {
	const s = form([{ id: "t", question: "T?" }]);
	assert.equal(s.mode, "text");
	assert.deepEqual(press(s, "escape").result, { answers: [], cancelled: true });
});

test("review up/down and Enter revisit a question", () => {
	let s = press(batch(), "down", "enter", "enter", "enter");
	assert.equal(s.current, 3);
	assert.equal(s.cursor, 3, "review opens on Send once everything is answered");
	s = press(s, "up", "up", "enter");
	assert.equal(s.current, 1);
	assert.equal(s.cursor, 0);
	s = press(s, "up", "enter");
	assert.equal(s.current, 3);
});

test("review Send does nothing until every question is answered", () => {
	const unanswered = press(atReview(batch()), "down", "down", "down", "enter");
	assert.equal(unanswered.result, undefined);
	assert.equal(unanswered.current, 3);
	const answered = press(batch(), "enter", "enter", "clarify", "enter");
	assert.equal(answered.result?.cancelled, false);
	assert.equal(answered.result?.answers.length, 3);
});

test("Esc in list cancels", () => {
	const s = press(batch(), "enter", "escape");
	assert.equal(s.result?.cancelled, true);
	assert.equal(s.result?.answers.length, 1);
});

test("revisiting a question puts the cursor on its first chosen index", () => {
	let s = press(batch(), "down", "enter", "left");
	assert.equal(s.current, 0);
	assert.equal(s.cursor, 1);
});

test("step never mutates its input, Maps and Sets included", () => {
	const multi = form([
		{ id: "m", question: "M?", multi: true, options: opts("x", "y") },
		{ id: "o", question: "O?", options: opts("p") },
	]);
	const events: FormEvent[] = [
		key("space"),
		key("note"),
		noteDraft("n"),
		key("enter"),
		key("printable"),
		draft("d"),
		key("escape"),
		key("down"),
		key("enter"),
		key("clarify"),
	];
	let s = multi;
	for (const event of events) {
		const before = structuredClone(s);
		const next = step(s, event);
		assert.deepEqual(s, before);
		s = next;
	}
	assert.equal(s.current, 2);
});

test("answer indices point into the recommended-first order", () => {
	const s = press(
		form([{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y", recommended: "best" }] }]),
		"enter",
	);
	const answer = s.result?.answers[0].answer;
	assert.deepEqual(answer, { kind: "selected", indices: [0] });
	assert.equal(s.questions[0].options?.[0].label, "y");
});

test("left/right and tab are ignored on a single question", () => {
	const s = press(single(), "right", "tab", "left", "shift+tab");
	assert.equal(s.current, 0);
	assert.equal(s.result, undefined);
});

test("pageUp and pageDown leave the state unchanged", () => {
	const s = batch();
	assert.equal(press(s, "pageUp", "pageDown"), s);
});

test("clearing clarify stays on the question when every other one is answered", () => {
	let s = press(batch(), "enter", "enter", "clarify");
	assert.equal(s.current, 3);
	s = press(s, "up", "enter", "clarify");
	assert.equal(isAnswered(s, "c"), false);
	assert.equal(s.current, 2);
});

test("escape from a note keeps the draft for the same question, leaving the question drops it", () => {
	let s = apply(press(batch(), "note"), noteDraft("half"), key("escape"));
	assert.equal(s.mode, "list");
	assert.equal(s.notes.has("a"), false);
	assert.equal(press(s, "note").noteDraft, "half");
	s = press(s, "right", "left", "note");
	assert.equal(s.noteDraft, "");
});

test("storing a blank note removes the note", () => {
	let s = apply(press(batch(), "note"), noteDraft("x"), key("enter"));
	s = apply(press(s, "note"), noteDraft(" "), key("enter"));
	assert.equal(s.notes.has("a"), false);
});

test("review tab/shift+tab cycle the cursor over question rows", () => {
	const s = atReview(batch());
	assert.equal(press(s, "tab").cursor, 1);
	assert.equal(press(s, "shift+tab").cursor, 2);
	assert.equal(press(s, "down", "down", "down", "tab").cursor, 0);
});

test("review ignores printable, space, left/right, and the chords", () => {
	const s = atReview(batch());
	assert.equal(press(s, "printable", "space", "left", "right", "note", "clarify"), s);
});

test("tab in text mode switches question, returns to list, and keeps the draft", () => {
	let s = apply(press(batch(), "printable"), draft("half"));
	s = press(s, "tab");
	assert.equal(s.current, 1);
	assert.equal(s.mode, "list");
	assert.equal(s.drafts.get("a"), "half");
	assert.equal(isAnswered(s, "a"), false);
	s = press(s, "shift+tab");
	assert.equal(s.current, 0);
	assert.equal(s.drafts.get("a"), "half");
});

test("shift+tab in text mode wraps to the review step, and tab from there to the first question", () => {
	const s = press(press(batch(), "printable"), "shift+tab");
	assert.equal(inReview(s), true);
	assert.equal(s.mode, "list");
	assert.equal(press(s, "shift+tab").current, 3, "in review, tab keys walk the review rows instead");
	assert.equal(step(s, { type: "jump", question: 0 }).current, 0);
	assert.equal(step(batch(), { type: "jump", question: 3 }).current, 3, "jumping to the Send tab opens the review");
});

test("tab in text mode on a single question stays in the editor", () => {
	const s = press(press(single(), "printable"), "tab", "shift+tab");
	assert.equal(s.current, 0);
	assert.equal(s.mode, "text");
});

test("tab in note mode switches question and drops the unsaved note draft", () => {
	const s = press(apply(press(batch(), "note"), noteDraft("half")), "tab");
	assert.equal(s.current, 1);
	assert.equal(s.mode, "list");
	assert.equal(s.noteDraft, "");
	assert.equal(s.notes.has("a"), false);
});

test("cancel ends the form as cancelled from any mode", () => {
	assert.equal(press(batch(), "cancel").result?.cancelled, true);
	assert.equal(press(batch(), "printable", "cancel").result?.cancelled, true);
	assert.equal(press(batch(), "note", "cancel").result?.cancelled, true);
	assert.equal(press(batch(), "enter", "enter", "enter", "cancel").result?.cancelled, true);
});

test("a batch question has a Send row after its options that sends once every question is answered", () => {
	let s = press(batch(), "down", "down", "down");
	assert.equal(s.cursor, 3, "the cursor reaches the Send row");
	assert.equal(press(s, "down").cursor, 3, "and stops there");
	assert.equal(press(s, "enter").result, undefined, "Send does nothing while questions are unanswered");
	s = press(batch(), "enter", "enter", "enter");
	assert.equal(s.current, 3, "all answered lands in review");
	s = press(s, "shift+tab", "down", "down", "down", "enter");
	assert.equal(s.result?.cancelled, false, "Send on the last question's row finishes");
	assert.equal(s.result?.answers.length, 3);
});

test("a single question's list ends at the Other row, which opens the editor on Enter", () => {
	const s = form([{ id: "a", question: "A?", options: opts("x", "y") }]);
	const other = press(s, "down", "down", "down");
	assert.equal(other.cursor, 2);
	assert.equal(press(other, "enter").mode, "text");
});

test("typing in the list moves the cursor to the Other row and a text answer reopens there", () => {
	let s = press(batch(), "printable");
	assert.equal(s.cursor, 2);
	s = step(s, { type: "draft", text: "mine" });
	s = press(s, "enter", "left");
	assert.equal(s.current, 0);
	assert.equal(s.cursor, 2);
});

test("a typed number chooses that option, toggles it on a multi, opens the editor from the Other row, and is otherwise ignored", () => {
	const pickNumber = (s: FormState, number: number) => step(s, { type: "pick", number });
	let s = pickNumber(batch(), 2);
	assert.deepEqual(s.answers.get("a"), { kind: "selected", indices: [1] });
	assert.equal(s.current, 1);
	s = pickNumber(s, 3);
	assert.equal(s.mode, "text");
	assert.equal(s.cursor, 2);
	const fresh = batch();
	assert.equal(pickNumber(fresh, 4), fresh, "past the Other row nothing happens");
	assert.equal(pickNumber(fresh, 0), fresh);
	const multi = pickNumber(form([{ id: "m", question: "M?", multi: true, options: opts("x", "y") }]), 2);
	assert.deepEqual([...multi.checked.get("m")!], [1]);
	assert.deepEqual(multi.answers.get("m"), { kind: "selected", indices: [1] });
	const typing = press(batch(), "printable");
	assert.equal(pickNumber(typing, 1), typing, "digits while typing are text");
});
