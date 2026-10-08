import assert from "node:assert/strict";
import { test } from "node:test";
import { callLabels, contextRejection, formatResult, labelFor, normalize, summarize } from "../extensions/call.ts";
import type { AskResult } from "../extensions/types.ts";

test("normalize derives labels from ids and fills options and multi", () => {
	const [a, b] = normalize({
		questions: [
			{ id: "a", question: "A?" },
			{ id: "retry_impl", question: "B?", multi: true },
		],
	});
	assert.equal(a.label, "A");
	assert.deepEqual(a.options, []);
	assert.equal(a.multi, false);
	assert.equal(b.label, "Retry impl");
	assert.equal(labelFor("retryImpl"), "Retry impl");
	assert.equal(labelFor("store-kind"), "Store kind");
	assert.equal(b.multi, true);
});

test("normalize sorts the recommended option first and keeps the rest in order", () => {
	const [q] = normalize({
		questions: [
			{
				id: "a",
				question: "A?",
				options: [{ label: "x" }, { label: "y" }, { label: "z", recommended: "best" }, { label: "w" }],
			},
		],
	});
	assert.deepEqual(q.options?.map((o) => o.label), ["z", "x", "y", "w"]);
});

test("normalize does not mutate the call", () => {
	const call = { questions: [{ id: "a", question: "A?", options: [{ label: "x" }, { label: "y", recommended: "best" }] }] };
	normalize(call);
	assert.deepEqual(call.questions[0].options?.map((o) => o.label), ["x", "y"]);
	assert.equal("label" in call.questions[0], false);
});

const questions = normalize({
	questions: [
		{ id: "store", question: "Which?", options: [{ label: "Redux" }, { label: "Zustand", recommended: "small" }] },
		{ id: "name", question: "Name?" },
		{ id: "flags", question: "Flags?", multi: true, options: [{ label: "a" }, { label: "b" }, { label: "c" }] },
		{ id: "skip", question: "Skip?", options: [{ label: "x" }] },
	],
});

const result: AskResult = {
	cancelled: false,
	answers: [
		{ id: "store", answer: { kind: "selected", indices: [0] } },
		{ id: "name", answer: { kind: "text", text: "line one\nline two" }, note: "my note" },
		{ id: "flags", answer: { kind: "selected", indices: [0, 2] } },
		{ id: "skip", answer: { kind: "clarify" } },
	],
};

test("summarize pairs each question with its answer in question order, labels through the recommended-first order", () => {
	assert.deepEqual(
		summarize(questions, result).map((entry) => [entry.label, entry.kind, entry.text, entry.note]),
		[
			["Store", "selected", "Zustand", undefined],
			["Name", "text", "line one\nline two", "my note"],
			["Flags", "selected", "a, c", undefined],
			["Skip", "clarify", "needs clarification", undefined],
		],
	);
	assert.equal(summarize(questions, { cancelled: true, answers: [] })[0].kind, "unanswered");
});

test("formatResult writes id-headed lines, indents multi-line text and notes, and names a cancellation", () => {
	assert.equal(
		formatResult(questions, result),
		["store: Zustand", "name:", "  line one", "  line two", "  note: my note", "flags: a, c", "skip: needs clarification"].join("\n"),
	);
	assert.match(formatResult(questions, { cancelled: true, answers: [] }), /closed the form/);
});

test("contextRejection passes a call whose every question has a context, however short", () => {
	assert.equal(contextRejection({ questions: [{ id: "a", context: "Tiny." }, { id: "b", context: "Also fine." }] }), undefined);
});

test("contextRejection names each question whose context is missing or blank", () => {
	const rejection = contextRejection({
		questions: [{ id: "ok", context: "Tiny." }, { id: "missing" }, { id: "blank", context: "  \n " }, { context: "" }],
	});
	assert.match(rejection ?? "", /for missing, blank, question 4\./);
	assert.doesNotMatch(rejection ?? "", /\bok\b/);
});

test("contextRejection leaves malformed calls to schema validation", () => {
	assert.equal(contextRejection(undefined), undefined);
	assert.equal(contextRejection({ questions: "not yet" }), undefined);
});

test("callLabels survives a call that is still streaming in", () => {
	assert.deepEqual(callLabels(undefined), []);
	assert.deepEqual(callLabels({}), []);
	assert.deepEqual(callLabels({ questions: "not yet" }), []);
	assert.deepEqual(callLabels({ questions: [{}, { id: "store" }, { id: "retry_impl" }, null] }), ["Q1", "Store", "Retry impl", "Q4"]);
});
