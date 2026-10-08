import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize } from "../extensions/call.ts";
import {
	ANSWERS_TAG,
	formatAnswersMessage,
	formatQuestionsForOrchestrator,
	isPauseText,
	PAUSE_MARKER,
	PAUSE_NOTICE,
	PENDING_NOTICE,
} from "../extensions/pause.ts";

const questions = () =>
	normalize({
		questions: [
			{
				id: "access",
				question: "Which access block?",
				context: "Only gates picker visibility.",
				options: [{ label: "Open to all" }, { label: "Restrict to AD groups", recommended: "matches the server gate", tradeoff: "fewer users see it" }],
			},
			{ id: "name", question: "Display name?" },
			{ id: "tags", question: "Which tags?", options: [{ label: "a" }, { label: "b" }], multi: true },
		],
	});

test("both notices carry the marker and isPauseText recognizes them", () => {
	assert.ok(PAUSE_NOTICE.startsWith(PAUSE_MARKER));
	assert.ok(PENDING_NOTICE.startsWith(PAUSE_MARKER));
	assert.ok(isPauseText(PAUSE_NOTICE));
	assert.ok(isPauseText(PENDING_NOTICE));
	assert.equal(isPauseText("access: Restrict"), false);
	assert.equal(isPauseText(` ${PAUSE_MARKER}`), false);
});

test("formatQuestionsForOrchestrator lists each question with context, options, and free-text/multi hints", () => {
	const text = formatQuestionsForOrchestrator(questions());
	const lines = text.split("\n");
	assert.equal(lines[0], "questions:");
	assert.equal(lines[1], "  access: Which access block?");
	assert.equal(lines[2], "    context: Only gates picker visibility.");
	assert.equal(lines[3], "    options:");
	assert.equal(lines[4], "      - Restrict to AD groups  (recommended: matches the server gate)  — fewer users see it");
	assert.equal(lines[5], "      - Open to all");
	assert.ok(text.includes("  name: Display name?\n    (free-text answer)"));
	assert.ok(text.includes("    options (several may apply):\n      - a\n      - b"));
});

test("formatQuestionsForOrchestrator explains an empty pause", () => {
	assert.match(formatQuestionsForOrchestrator([]), /^questions: \(the subagent paused without recording any/);
});

test("formatAnswersMessage wraps one line per question, marks missing answers, and passes extra ids through", () => {
	const text = formatAnswersMessage(questions(), { access: "Restrict to AD groups", extra: "yes", tags: "" });
	const lines = text.split("\n");
	assert.equal(lines[0], `<${ANSWERS_TAG}>`);
	assert.equal(lines[1], "access: Restrict to AD groups");
	assert.equal(lines[2], "name: (no answer given; proceed if not essential, otherwise ask again)");
	assert.equal(lines[3], "tags: (no answer given; proceed if not essential, otherwise ask again)");
	assert.equal(lines[4], "extra: yes");
	assert.equal(lines[5], `</${ANSWERS_TAG}>`);
	assert.equal(lines[lines.length - 1], "Continue the task with these answers.");
});

test("formatAnswersMessage indents a multi-line answer under its id", () => {
	const text = formatAnswersMessage(normalize({ questions: [{ id: "plan", question: "Plan?" }] }), { plan: "first\nsecond" });
	assert.ok(text.includes("plan:\n  first\n  second\n"));
});
