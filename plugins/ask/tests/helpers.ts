import { normalize } from "../extensions/call.ts";
import { initialState, step } from "../extensions/state.ts";
import type { AskQuestion, FormState, KeyName } from "../extensions/types.ts";

export const opts = (...labels: string[]) => labels.map((label) => ({ label }));

export function form(questions: AskQuestion[]): FormState {
	return initialState(normalize({ questions }));
}

export function press(state: FormState, ...keys: KeyName[]): FormState {
	return keys.reduce((s, key) => step(s, { type: "key", key }), state);
}

/** Three two-option questions, ids a, b, c. */
export const batch = () =>
	form([
		{ id: "a", question: "A?", options: opts("a1", "a2") },
		{ id: "b", question: "B?", options: opts("b1", "b2") },
		{ id: "c", question: "C?", options: opts("c1", "c2") },
	]);
