/** Pure form state: a key or draft event in, the next state out. */

import type { Answer, AskQuestion, AskResult, FormEvent, FormState, KeyName } from "./types.ts";

function optionCount(question: AskQuestion): number {
	return question.options?.length ?? 0;
}

/**
 * A question's list, by cursor index: its options, then the Other row that
 * opens the text editor, then a multi-select's Next row, then a batch's Send
 * row.
 */
export function otherRowIndex(question: AskQuestion): number {
	return optionCount(question);
}

export function nextRowIndex(question: AskQuestion): number {
	return otherRowIndex(question) + 1;
}

export function sendRowIndex(question: AskQuestion): number {
	return nextRowIndex(question) + (question.multi ? 1 : 0);
}

/** Return the last cursor index of the current list: the Send row in a batch, else the Next row on a multi, else the Other row. */
function lastListRow(state: FormState): number {
	const question = state.questions[state.current];
	if (isBatch(state)) return sendRowIndex(question);
	return question.multi ? nextRowIndex(question) : otherRowIndex(question);
}

/** Report whether the cursor sits on the Other row. */
export function onOtherRow(state: FormState): boolean {
	return state.cursor === otherRowIndex(state.questions[state.current]);
}

/** Report whether the cursor sits on a multi-select's Next row. */
export function onNextRow(state: FormState): boolean {
	const question = state.questions[state.current];
	return (question.multi ?? false) && state.cursor === nextRowIndex(question);
}

/** Report whether the cursor sits on a batch question's Send row. */
export function onSendRow(state: FormState): boolean {
	return isBatch(state) && state.cursor === sendRowIndex(state.questions[state.current]);
}

/** Report whether the form has more than one question. */
export function isBatch(state: FormState): boolean {
	return state.questions.length > 1;
}

/** Report whether the form is on its review step. */
export function inReview(state: FormState): boolean {
	return state.current === state.questions.length;
}

function clamp(value: number, max: number): number {
	return Math.max(0, Math.min(value, max));
}

function cycle(value: number, delta: number, size: number): number {
	return (value + delta + size) % size;
}

/** Return the cursor a question opens with: its first chosen index, else 0. */
/** Return the cursor a question opens on: its chosen option, the Other row after a text answer, else the top. */
function openingCursor(question: AskQuestion, answers: Map<string, Answer>): number {
	const answer = answers.get(question.id);
	if (answer?.kind === "selected") return answer.indices[0] ?? 0;
	return answer?.kind === "text" ? otherRowIndex(question) : 0;
}

function openingMode(question: AskQuestion): FormState["mode"] {
	return optionCount(question) === 0 ? "text" : "list";
}

/**
 * Move to a question, setting cursor and mode for it. Drops any unsaved note
 * draft, since `noteDraft` only ever belongs to the current question.
 */
function goTo(state: FormState, index: number): FormState {
	const question = state.questions[index];
	return {
		...state,
		current: index,
		cursor: openingCursor(question, state.answers),
		mode: openingMode(question),
		noteDraft: "",
	};
}

/** Open the review step, on Send when everything is answered so Enter sends, else on the first question. */
function goToReview(state: FormState): FormState {
	const cursor = allAnswered(state) ? state.questions.length : 0;
	return { ...state, current: state.questions.length, cursor, mode: "list", noteDraft: "" };
}

/** Build the initial state, opening on the first question. */
export function initialState(questions: AskQuestion[]): FormState {
	const base: FormState = {
		questions,
		current: 0,
		cursor: 0,
		mode: "list",
		checked: new Map(),
		drafts: new Map(),
		notes: new Map(),
		noteDraft: "",
		answers: new Map(),
	};
	return goTo(base, 0);
}

/** Report whether a question has an answer, a clarify flag included. */
export function isAnswered(state: FormState, id: string): boolean {
	return state.answers.has(id);
}

/** Report whether every question has an answer, a clarify flag included. */
export function allAnswered(state: FormState): boolean {
	return state.questions.every((question) => isAnswered(state, question.id));
}

/** Collect answered questions in order, each with its note. */
export function buildResult(state: FormState, cancelled: boolean): AskResult {
	const answers: AskResult["answers"] = [];
	for (const question of state.questions) {
		const answer = state.answers.get(question.id);
		if (!answer) continue;
		const note = state.notes.get(question.id);
		answers.push(note === undefined ? { id: question.id, answer } : { id: question.id, answer, note });
	}
	return { answers, cancelled };
}

function finish(state: FormState, cancelled: boolean): FormState {
	return { ...state, result: buildResult(state, cancelled) };
}

function withAnswer(state: FormState, id: string, answer: Answer): FormState {
	const answers = new Map(state.answers);
	answers.set(id, answer);
	return { ...state, answers };
}

function withoutAnswer(state: FormState, id: string): FormState {
	const answers = new Map(state.answers);
	answers.delete(id);
	return { ...state, answers };
}

/**
 * Move to the next unanswered question after the current one, wrapping back
 * to the current one itself, else to review or finish.
 */
function advance(state: FormState): FormState {
	const count = state.questions.length;
	for (let offset = 1; offset <= count; offset++) {
		const index = (state.current + offset) % count;
		if (!isAnswered(state, state.questions[index].id)) return goTo(state, index);
	}
	return isBatch(state) ? goToReview(state) : finish(state, false);
}

function currentQuestion(state: FormState): AskQuestion {
	return state.questions[state.current];
}

function moveCursor(state: FormState, delta: number): FormState {
	const max = inReview(state) ? state.questions.length : lastListRow(state);
	return { ...state, cursor: clamp(state.cursor + delta, max) };
}

/** Move to the neighbouring tab, the review step included in the cycle. */
function switchQuestion(state: FormState, delta: number): FormState {
	if (!isBatch(state)) return state;
	return jump(state, cycle(state.current, delta, state.questions.length + 1));
}

/** Toggle the cursor option of a multi-select and record the checked set as the answer at once, so a question counts as answered as soon as one box is checked; unchecking the last box removes the answer. */
function toggleChecked(state: FormState): FormState {
	const question = currentQuestion(state);
	if (!question.multi || state.cursor >= otherRowIndex(question)) return state;
	const set = new Set(state.checked.get(question.id));
	if (!set.delete(state.cursor)) set.add(state.cursor);
	const checked = new Map(state.checked);
	checked.set(question.id, set);
	const next = { ...state, checked };
	if (set.size === 0) return withoutAnswer(next, question.id);
	return withAnswer(next, question.id, { kind: "selected", indices: [...set].sort((a, b) => a - b) });
}

/** Return the cursor index for a single-select, the sorted checked set for a multi, or null when a multi has nothing checked. */
function chosenIndices(state: FormState): number[] | null {
	const question = currentQuestion(state);
	if (!question.multi) return [state.cursor];
	const set = state.checked.get(question.id);
	if (!set || set.size === 0) return null;
	return [...set].sort((a, b) => a - b);
}

/** Open the text editor from the Other row. */
function startTyping(state: FormState): FormState {
	return { ...state, mode: "text", cursor: otherRowIndex(currentQuestion(state)) };
}

/** Send the form from the Send row once every question is answered; open the editor from the Other row; choose the cursor option on a single-select; on a multi, toggle the option, or commit the checked set from the Next row. */
function confirmOption(state: FormState): FormState {
	if (onSendRow(state)) return allAnswered(state) ? finish(state, false) : state;
	if (onOtherRow(state)) return startTyping(state);
	if (currentQuestion(state).multi && !onNextRow(state)) return toggleChecked(state);
	const indices = chosenIndices(state);
	if (indices === null) return state;
	return advance(withAnswer(state, currentQuestion(state).id, { kind: "selected", indices }));
}

function toggleClarify(state: FormState): FormState {
	const id = currentQuestion(state).id;
	if (state.answers.get(id)?.kind === "clarify") return advance(withoutAnswer(state, id));
	return advance(withAnswer(state, id, { kind: "clarify" }));
}

/** Open the note editor on an unsaved draft if one survives an earlier escape, else on the stored note. */
function openNote(state: FormState): FormState {
	const noteDraft = state.noteDraft || (state.notes.get(currentQuestion(state).id) ?? "");
	return { ...state, mode: "note", noteDraft };
}

function listKey(state: FormState, key: KeyName): FormState {
	switch (key) {
		case "up":
			return moveCursor(state, -1);
		case "down":
			return moveCursor(state, 1);
		case "left":
		case "shift+tab":
			return switchQuestion(state, -1);
		case "right":
		case "tab":
			return switchQuestion(state, 1);
		case "space":
			return toggleChecked(state);
		case "enter":
			return confirmOption(state);
		case "printable":
			return startTyping(state);
		case "note":
			return openNote(state);
		case "clarify":
			return toggleClarify(state);
		case "escape":
			return finish(state, true);
		default:
			return state;
	}
}

function commitDraft(state: FormState): FormState {
	const id = currentQuestion(state).id;
	const text = state.drafts.get(id) ?? "";
	if (text.trim() === "") return state;
	return advance(withAnswer(state, id, { kind: "text", text }));
}

/** Switch questions from inside an editor on tab/shift+tab; null for any other key. */
function editorTab(state: FormState, key: KeyName): FormState | null {
	if (key === "tab") return switchQuestion(state, 1);
	if (key === "shift+tab") return switchQuestion(state, -1);
	return null;
}

function textKey(state: FormState, key: KeyName): FormState {
	if (key === "enter") return commitDraft(state);
	const switched = editorTab(state, key);
	if (switched) return switched;
	if (key !== "escape") return state;
	if (optionCount(currentQuestion(state)) === 0) return finish(state, true);
	return { ...state, mode: "list" };
}

/** Save the note draft, or remove the note when the draft is blank. */
function storeNote(state: FormState): FormState {
	const id = currentQuestion(state).id;
	const notes = new Map(state.notes);
	if (state.noteDraft.trim() === "") notes.delete(id);
	else notes.set(id, state.noteDraft);
	return { ...state, notes, noteDraft: "", mode: "list" };
}

function noteKey(state: FormState, key: KeyName): FormState {
	if (key === "enter") return storeNote(state);
	if (key === "escape") return { ...state, mode: "list" };
	return editorTab(state, key) ?? state;
}

function confirmReviewRow(state: FormState): FormState {
	if (state.cursor < state.questions.length) return goTo(state, state.cursor);
	return allAnswered(state) ? finish(state, false) : state;
}

/** Move the review cursor over question rows only; from Send, count from the last question. */
function cycleReviewCursor(state: FormState, delta: number): FormState {
	const count = state.questions.length;
	return { ...state, cursor: cycle(Math.min(state.cursor, count - 1), delta, count) };
}

function reviewKey(state: FormState, key: KeyName): FormState {
	switch (key) {
		case "up":
			return moveCursor(state, -1);
		case "down":
			return moveCursor(state, 1);
		case "tab":
			return cycleReviewCursor(state, 1);
		case "shift+tab":
			return cycleReviewCursor(state, -1);
		case "enter":
			return confirmReviewRow(state);
		case "escape":
			return finish(state, true);
		default:
			return state;
	}
}

function keyStep(state: FormState, key: KeyName): FormState {
	if (key === "cancel") return finish(state, true);
	if (inReview(state)) return reviewKey(state, key);
	if (state.mode === "text") return textKey(state, key);
	if (state.mode === "note") return noteKey(state, key);
	return listKey(state, key);
}

function withDraft(state: FormState, text: string): FormState {
	const drafts = new Map(state.drafts);
	drafts.set(currentQuestion(state).id, text);
	return { ...state, drafts };
}

/**
 * Act on a typed number as if the user had moved to that row and pressed
 * Enter: an option is chosen (toggled on a multi), the Other row opens the
 * editor. Numbers past the Other row, and any number outside list mode, do
 * nothing.
 */
function pick(state: FormState, number: number): FormState {
	if (inReview(state) || state.mode !== "list") return state;
	const index = number - 1;
	if (index < 0 || index > otherRowIndex(currentQuestion(state))) return state;
	return confirmOption({ ...state, cursor: index });
}

/** Move the cursor to a row and press Enter there: a review row or Send in review, else any list row. Out-of-range rows and editor modes do nothing. */
function activate(state: FormState, cursor: number): FormState {
	if (state.mode !== "list" || cursor < 0) return state;
	if (inReview(state)) return cursor > state.questions.length ? state : confirmReviewRow({ ...state, cursor });
	return cursor > lastListRow(state) ? state : confirmOption({ ...state, cursor });
}

/** Open another tab of a batch from anywhere in the form: a question, or the review step at `questions.length`. */
function jump(state: FormState, question: number): FormState {
	if (!isBatch(state) || question < 0 || question > state.questions.length || question === state.current) return state;
	return question === state.questions.length ? goToReview(state) : goTo(state, question);
}

/** Apply one event and return the next state. Never mutates the input. */
export function step(state: FormState, event: FormEvent): FormState {
	if (state.result) return state;
	switch (event.type) {
		case "key":
			return keyStep(state, event.key);
		case "pick":
			return pick(state, event.number);
		case "activate":
			return activate(state, event.cursor);
		case "jump":
			return jump(state, event.question);
		case "draft":
			return inReview(state) ? state : withDraft(state, event.text);
		case "noteDraft":
			return { ...state, noteDraft: event.text };
	}
}
