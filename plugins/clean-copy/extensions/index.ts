// Strips the transcript's left padding from mouse-selected text before it
// reaches the clipboard in fullscreen mode.
//
// Pi copies the rendered screen cells verbatim, so every selected line
// carries the one-column gutter pi draws before the transcript. Each line
// loses exactly one leading space rather than the common indent, because a
// selection that starts mid-line has no gutter on its first line and would
// otherwise leave the rest untouched. The TUI exposes a `copySelection`
// callback but doesn't let extensions set it, so this grabs the TUI instance
// through an invisible widget and swaps the callback at runtime.

import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUTTER = " ";

function dedent(text: string): string {
	return text
		.split("\n")
		.map((l) => (l.startsWith(GUTTER) ? l.slice(GUTTER.length) : l))
		.join("\n");
}

async function copyClean(text: string): Promise<boolean | string> {
	try {
		await copyToClipboard(dedent(text));
		return true;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWidget("clean-copy", (tui) => {
			const target = tui as unknown as { copySelection?: unknown };
			if ("copySelection" in target) target.copySelection = copyClean;
			return { render: () => [], invalidate() {} };
		});
	});
}
