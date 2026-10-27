// Restores the agent's original line breaks in mouse-selected text before it
// reaches the clipboard in fullscreen mode.
//
// Pi copies the rendered screen cells verbatim, so a selection carries a
// newline at every row boundary, including rows pi only wrapped to fit the
// terminal, plus the one-column gutter pi draws before the transcript. The
// screen has no record of which breaks were real, but the session does: this
// collapses the selection's whitespace, finds it in the text of the
// assistant messages, and copies that slice of the source, so newlines are
// exactly the ones the agent wrote. When the selection doesn't match any
// message (tool output, styled markdown that renders differently), it falls
// back to stripping the gutter only. The TUI exposes a `copySelection`
// callback but doesn't let extensions set it, so this grabs the TUI instance
// through an invisible widget and swaps the callback at runtime.

import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findInSources } from "./source-text.ts";

const GUTTER = " ";

let getSources: () => string[] = () => [];

function dedent(text: string): string {
	return text
		.split("\n")
		.map((l) => (l.startsWith(GUTTER) ? l.slice(GUTTER.length) : l))
		.join("\n");
}

function clean(text: string): string {
	return findInSources(text, getSources()) ?? dedent(text);
}

async function copyClean(text: string): Promise<boolean | string> {
	try {
		await copyToClipboard(clean(text));
		return true;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Text parts of assistant messages on the current branch, newest first. */
function assistantTexts(ctx: ExtensionContext): string[] {
	const texts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && part.text) texts.push(part.text);
		}
	}
	return texts.reverse();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		getSources = () => assistantTexts(ctx);
		ctx.ui.setWidget("clean-copy", (tui) => {
			const target = tui as unknown as { copySelection?: unknown };
			if ("copySelection" in target) target.copySelection = copyClean;
			return { render: () => [], invalidate() {} };
		});
	});
}
