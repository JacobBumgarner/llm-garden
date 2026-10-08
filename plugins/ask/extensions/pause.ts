/**
 * The pause protocol between a headless `ask` and the orchestrator that answers it.
 *
 * Outside the TUI there is nobody at the terminal, so `ask` cannot show its
 * form. Instead the call is blocked with a `PAUSED:` result and the run ends.
 * The process that spawned the agent reads the questions back out of the
 * transcript, obtains answers, and resumes the same session with a message
 * wrapped in `<orchestrator-answers>`. Pure functions and constants only, so
 * both the `ask` and `subagent` extensions can import them.
 */

import type { AskQuestion } from "./types.ts";

export const PAUSE_MARKER = "PAUSED:";

export const ANSWERS_TAG = "orchestrator-answers";

export const PAUSE_NOTICE =
	`${PAUSE_MARKER} your questions were relayed to the orchestrator. Your turn ends here; ` +
	`the answers arrive as your next message inside <${ANSWERS_TAG}>. Do not act on an open question before then.`;

export const PENDING_NOTICE = `${PAUSE_MARKER} a question is already pending; stop and wait for the orchestrator's answers.`;

/** Whether a tool-result text is the pause notice a blocked `ask` produced. */
export function isPauseText(text: string): boolean {
	return text.startsWith(PAUSE_MARKER);
}

function indent(text: string, by: string): string {
	return text
		.split("\n")
		.map((line) => by + line)
		.join("\n");
}

/** Render one question with its context and options, four spaces in, for the orchestrator. */
function formatQuestion(question: AskQuestion): string {
	const lines = [`  ${question.id}: ${question.question}`];
	if (question.context) lines.push(indent(`context: ${question.context}`, "    "));
	if (question.options && question.options.length > 0) {
		lines.push(`    options${question.multi ? " (several may apply)" : ""}:`);
		for (const option of question.options) {
			let line = `      - ${option.label}`;
			if (option.recommended) line += `  (recommended: ${option.recommended})`;
			if (option.tradeoff) line += `  — ${option.tradeoff}`;
			lines.push(line);
		}
	} else {
		lines.push("    (free-text answer)");
	}
	return lines.join("\n");
}

/** Render the questions block of a paused result: `questions:` followed by each question. */
export function formatQuestionsForOrchestrator(questions: AskQuestion[]): string {
	if (questions.length === 0) return "questions: (the subagent paused without recording any; resume with an empty answers object to let it re-ask)";
	return ["questions:", ...questions.map(formatQuestion)].join("\n");
}

/**
 * Build the message that resumes a paused agent: the answers inside
 * `<orchestrator-answers>`, one `id: answer` line per question, then an
 * instruction to continue. Question ids with no answer are marked so the agent
 * can re-ask if the point is essential; answers for ids the agent never asked
 * are passed through unchanged.
 */
export function formatAnswersMessage(questions: AskQuestion[], answers: Record<string, string>): string {
	const ids = [...questions.map((question) => question.id), ...Object.keys(answers).filter((id) => !questions.some((q) => q.id === id))];
	const lines = ids.map((id) => {
		const answer = answers[id];
		if (answer === undefined || answer.trim() === "") return `${id}: (no answer given; proceed if not essential, otherwise ask again)`;
		return answer.includes("\n") ? `${id}:\n${indent(answer, "  ")}` : `${id}: ${answer}`;
	});
	return [`<${ANSWERS_TAG}>`, ...lines, `</${ANSWERS_TAG}>`, "", "Continue the task with these answers."].join("\n");
}
