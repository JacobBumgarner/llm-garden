/**
 * Stash the editor's current text in memory with ctrl+s, and pop it back with
 * ctrl+s when the editor is empty. Mirrors Claude Code's prompt stash.
 *
 * - Editor has text and stash is empty  -> stash it, clear the editor.
 * - Editor is empty and stash has text  -> restore it, clear the stash.
 * - Both have text                       -> swap them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let stash = "";

	pi.registerShortcut(Key.ctrl("s"), {
		description: "Stash / restore the current prompt",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;

			const current = ctx.ui.getEditorText();
			const next = stash;
			stash = current;
			ctx.ui.setEditorText(next);

			if (current && next) ctx.ui.notify("Swapped stashed prompt", "info");
			else if (current) ctx.ui.notify("Prompt stashed", "info");
			else if (next) ctx.ui.notify("Prompt restored", "info");
		},
	});
}
