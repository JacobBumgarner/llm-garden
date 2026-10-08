/**
 * The `ask` extension: one tool that asks the user structured questions in a form.
 *
 * A call with any question missing its `context` is blocked with a
 * rejection the model can act on, since the user never sees the model's
 * thinking. The form needs a terminal. Outside the TUI (print, JSON, and RPC modes) a
 * call to `ask` is blocked with a `PAUSED:` result and the run ends, so an
 * orchestrator can read the questions from the transcript, answer them, and
 * resume the session. See `pause.ts` for the protocol.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AnswerSummary, callLabels, contextRejection, formatResult, normalize, summarize } from "./call.ts";
import { PAUSE_NOTICE, PENDING_NOTICE } from "./pause.ts";
import type { AskQuestion, AskResult } from "./types.ts";
import { AskForm } from "./view.ts";

interface AskDetails {
	questions: AskQuestion[];
	result: AskResult;
	/** Set when the call ran headless and was relayed to an orchestrator instead of shown. */
	paused?: true;
}

const SUMMARY_GLYPHS: Record<AnswerSummary["kind"], string> = {
	selected: "✓",
	text: "✓",
	clarify: "?",
	unanswered: "○",
};

/** Paint the call line: the tool name and the question labels written so far. */
function paintCall(args: unknown, theme: Theme): Text {
	const labels = callLabels(args);
	const head = theme.fg("toolTitle", theme.bold("ask"));
	if (labels.length === 0) return new Text(head, 0, 0);
	const count = labels.length === 1 ? "1 question" : `${labels.length} questions`;
	return new Text(`${head} ${theme.fg("dim", `${count}: `)}${theme.fg("accent", labels.join(", "))}`, 0, 0);
}

/** Paint one answer: its mark, label, and answer on one line, with the note and further text lines under it when expanded. */
function paintAnswer(entry: AnswerSummary, expanded: boolean, theme: Theme): string {
	const [first, ...rest] = entry.text.split("\n");
	const mark = theme.fg(entry.kind === "clarify" ? "warning" : entry.kind === "unanswered" ? "dim" : "success", SUMMARY_GLYPHS[entry.kind]);
	const more = !expanded && (rest.length > 0 || entry.note) ? theme.fg("dim", " …") : "";
	const lines = [`${mark} ${theme.fg("muted", entry.label)}  ${first}${more}`];
	if (expanded) {
		lines.push(...rest.map((line) => `    ${line}`));
		if (entry.note) lines.push(`    ${theme.fg("dim", `note: ${entry.note}`)}`);
	}
	return lines.join("\n");
}

/** Paint the result block: one line per question, or the cancellation. */
function paintResult(details: AskDetails, expanded: boolean, theme: Theme): Text {
	if (details.paused) return new Text(theme.fg("warning", "paused — relayed to the orchestrator"), 0, 0);
	if (details.result.cancelled) return new Text(theme.fg("warning", "cancelled"), 0, 0);
	const lines = summarize(details.questions, details.result).map((entry) => paintAnswer(entry, expanded, theme));
	return new Text(lines.join("\n"), 0, 0);
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "The choice, in a few words." }),
	tradeoff: Type.Optional(Type.String({ description: "What this choice costs or risks, one line." })),
	recommended: Type.Optional(
		Type.String({ description: "A one-line reason this is your pick. Put it on at most one option, and only when you have a view." }),
	),
	preview: Type.Optional(
		Type.String({
			description:
				"A code or config sample showing this option, inside a ```lang fence, up to 30 lines. Shown while the option is highlighted; add one when seeing it helps the user choose.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Short slug, unique within the call. Answers come back as `id: answer`." }),
	question: Type.String({ description: "The decision, one line." }),
	context: Type.String({
		description:
			"Everything the user needs to decide. The user sees only this form, never your thinking, " +
			"so state what the decision is about, what you found, and what each path changes. Name things in full; do not refer to " +
			"anything the user may not have seen, such as 'the first two' or a list you made while thinking.",
	}),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Two to eight choices; a yes/no question gets two. Omit for a free-text answer. The form always lets the user type their own answer, add a note, or flag the question as unclear, so do not add an Other option.",
		}),
	),
	multi: Type.Optional(Type.Boolean({ description: "Let the user choose several of the options." })),
});

const AskSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One to six questions." }),
});

const DESCRIPTION =
	"Show the user a form and wait for their decisions. Use it when you need a choice you cannot make yourself; ask open-ended or conversational questions in your reply instead.";

const PROMPT_SNIPPET = "ask: show the user a form of up to six questions and wait for their decisions";

const PROMPT_GUIDELINES = [
	"Gather every open decision that does not depend on another's answer into one ask call, and read enough first that every option you offer is viable.",
	"Your thinking is never shown to the user. Put every finding behind an ask question into its `context`, and write option labels and tradeoffs that make sense without your reasoning.",
	"When an ask answer is `needs clarification`, the question was unclear: re-ask it in prose in your reply, not with another ask call.",
];

export default function (pi: ExtensionAPI) {
	let pending = false;

	pi.on("agent_start", () => {
		pending = false;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "ask") {
			const rejection = contextRejection(event.input);
			if (rejection) return { block: true, reason: rejection };
		}
		if (ctx.mode === "tui") return undefined;
		if (event.toolName === "ask") {
			pending = true;
			return { block: true, terminate: true, reason: PAUSE_NOTICE };
		}
		if (pending) return { block: true, terminate: true, reason: PENDING_NOTICE };
		return undefined;
	});

	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskSchema,
		exposure: "model-only",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const questions = normalize(params);
			if (ctx.mode !== "tui") {
				const details: AskDetails = { questions, result: { answers: [], cancelled: true }, paused: true };
				return { content: [{ type: "text", text: PAUSE_NOTICE }], details };
			}
			const result = await ctx.ui.custom<AskResult>((tui, theme, _kb, done) => new AskForm(tui, theme, questions, done));
			const details: AskDetails = { questions, result };
			return { content: [{ type: "text", text: formatResult(questions, result) }], details };
		},
		renderCall(args, theme) {
			return paintCall(args, theme);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "waiting for answers…"), 0, 0);
			const details = result.details as AskDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "no answers recorded"), 0, 0);
			return paintResult(details, expanded, theme);
		},
	});
}
