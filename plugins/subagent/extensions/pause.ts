/**
 * Pause handling for subagent runs: read a child's final output and detect a
 * run that ended on a blocked `ask`. Pure functions over the child's message
 * list. The `ask` extension's `pause.ts` owns the protocol text.
 */

import type { Message } from "@earendil-works/pi-ai";
import { normalize } from "../../ask/extensions/call.ts";
import { isPauseText } from "../../ask/extensions/pause.ts";
import type { AskQuestion } from "../../ask/extensions/types.ts";

/** The text of the last assistant message, or "" when there is none. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/**
 * Return the questions of a run that ended on a blocked `ask`, or undefined when
 * the run did not pause. The questions come from the `ask` call's arguments;
 * the blocked result carries only the pause notice. A pause whose call cannot
 * be found yields an empty list.
 */
export function detectPause(messages: Message[]): AskQuestion[] | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "toolResult" || msg.toolName !== "ask") continue;
		const text = msg.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (!isPauseText(text)) continue;
		for (const candidate of messages) {
			if (candidate.role !== "assistant") continue;
			for (const part of candidate.content) {
				if (part.type === "toolCall" && part.id === msg.toolCallId) {
					const raw = part.arguments as { questions?: AskQuestion[] } | undefined;
					return normalize({ questions: Array.isArray(raw?.questions) ? raw.questions : [] });
				}
			}
		}
		return [];
	}
	return undefined;
}
