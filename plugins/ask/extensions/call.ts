/** Turn a raw ask call into the form the state and view work from, and a result back into text. */

import type { Answer, AskCall, AskOption, AskQuestion, AskResult } from "./types.ts";

/** Return the options with the recommended one first, order otherwise unchanged. */
function recommendedFirst(options: AskOption[]): AskOption[] {
	const recommended = options.filter((option) => option.recommended);
	const rest = options.filter((option) => !option.recommended);
	return [...recommended, ...rest];
}

/** Turn an id into a tab label: `retry_impl` and `retryImpl` both become `Retry impl`. */
export function labelFor(id: string): string {
	const words = id
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeQuestion(question: AskQuestion): AskQuestion {
	return {
		...question,
		label: labelFor(question.id),
		options: recommendedFirst(question.options ?? []),
		multi: question.multi ?? false,
	};
}

/** Fill default labels, options, and multi, and sort the recommended option first. */
export function normalize(call: AskCall): AskQuestion[] {
	return call.questions.map(normalizeQuestion);
}

/** One question's outcome, flattened for the transcript and the model: the answer as text, with its note. */
export interface AnswerSummary {
	id: string;
	label: string;
	kind: "selected" | "text" | "clarify" | "unanswered";
	text: string;
	note?: string;
}

function answerText(question: AskQuestion, answer: Answer): string {
	switch (answer.kind) {
		case "selected":
			return answer.indices.map((index) => question.options?.[index]?.label ?? `option ${index}`).join(", ");
		case "text":
			return answer.text;
		case "clarify":
			return "needs clarification";
	}
}

/** Pair every question with what the user did about it, in question order. */
export function summarize(questions: AskQuestion[], result: AskResult): AnswerSummary[] {
	const byId = new Map(result.answers.map((entry) => [entry.id, entry]));
	return questions.map((question) => {
		const entry = byId.get(question.id);
		const base = { id: question.id, label: question.label ?? labelFor(question.id), note: entry?.note };
		if (!entry) return { ...base, kind: "unanswered", text: "unanswered" };
		return { ...base, kind: entry.answer.kind, text: answerText(question, entry.answer) };
	});
}

/** Indent every line after the first so a multi-line answer stays under its heading. */
function indented(text: string): string {
	return text.split("\n").join("\n  ");
}

/**
 * Format the result for the model: one `id: answer` line per question, a
 * multi-line answer indented under its id, a note on its own indented line,
 * or a single cancellation line.
 */
export function formatResult(questions: AskQuestion[], result: AskResult): string {
	if (result.cancelled) return "The user closed the form without answering. If the answers matter, ask in prose in your reply, not with another ask call.";
	return summarize(questions, result)
		.map((entry) => {
			const head = entry.text.includes("\n") ? `${entry.id}:\n  ${indented(entry.text)}` : `${entry.id}: ${entry.text}`;
			return entry.note ? `${head}\n  note: ${indented(entry.note)}` : head;
		})
		.join("\n");
}

/** Return the rejection to send back when any question's context is missing or blank, or undefined when every question has one. */
export function contextRejection(call: unknown): string | undefined {
	const questions = (call as { questions?: unknown } | undefined)?.questions;
	if (!Array.isArray(questions)) return undefined;
	const thin = questions
		.map((question, index) => {
			const q = question as { id?: unknown; context?: unknown } | undefined;
			const blank = typeof q?.context !== "string" || q.context.trim() === "";
			return blank ? (typeof q?.id === "string" ? q.id : `question ${index + 1}`) : undefined;
		})
		.filter((id) => id !== undefined);
	if (thin.length === 0) return undefined;
	return (
		`ask rejected: context is missing for ${thin.join(", ")}. ` +
		"The user sees only the form, never your thinking. Call ask again with each context stating what the decision is about, " +
		"what you found, and what each option changes, naming things in full."
	);
}

/** Return the labels of a call's questions as the model has written them so far; the call arrives incrementally while it streams, so any part may be missing. */
export function callLabels(call: unknown): string[] {
	const questions = (call as { questions?: unknown } | undefined)?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.map((question, index) => {
		const q = question as { id?: unknown } | undefined;
		return typeof q?.id === "string" ? labelFor(q.id) : `Q${index + 1}`;
	});
}
