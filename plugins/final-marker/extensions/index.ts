/**
 * Final marker: draw a horizontal rule above the assistant message that ends a turn.
 *
 * Intermediate narration between tool calls stays unmarked, so the rule says "this is the answer"
 * while scrolling. pi emits `message_end` to extensions before it renders the finished message, so
 * the message's first text block is recorded as final when it carries no tool calls, and the
 * markdown transformer prefixes the rule when it sees that text again. The rule is drawn as a
 * pre-colored `\u2500` line sized to the available width, because pi's markdown `---` caps at 80 columns.
 * Rendering only: the session file and the model see the original text.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

/** A full-width rule in the markdown hr color, followed by a paragraph break. */
export function rule(theme: Theme, width: number): string {
	return `${theme.fg("mdHr", "\u2500".repeat(Math.max(1, width)))}\n\n`;
}
const MAX_REMEMBERED = 500;

/** The first non-empty text block of an assistant message that ends a turn, else undefined. */
export function finalText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	for (const block of message.content) {
		if (block.type === "text" && block.text.trim() !== "") return block.text.trim();
	}
	return undefined;
}

/** Bounded set of final texts: the oldest entry drops once the cap is reached. */
export class FinalTexts {
	private texts = new Set<string>();

	add(text: string): void {
		this.texts.delete(text);
		this.texts.add(text);
		if (this.texts.size > MAX_REMEMBERED) {
			const oldest = this.texts.values().next().value;
			if (oldest !== undefined) this.texts.delete(oldest);
		}
	}

	has(text: string): boolean {
		return this.texts.has(text);
	}

	clear(): void {
		this.texts.clear();
	}
}

export default function (pi: ExtensionAPI) {
	const finals = new FinalTexts();
	let theme: Theme | undefined;

	pi.on("session_start", (_event, ctx) => {
		theme = ctx.ui.theme;
		finals.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const text = finalText(entry.message);
			if (text !== undefined) finals.add(text);
		}
	});

	pi.on("message_end", (event) => {
		const text = finalText(event.message);
		if (text !== undefined) finals.add(text);
	});

	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming, availableWidth }) => {
		if (messageType !== "assistant" || isStreaming || !theme) return markdown;
		return finals.has(markdown.trim()) ? rule(theme, availableWidth) + markdown : markdown;
	});
}
