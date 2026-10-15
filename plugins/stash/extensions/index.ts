/**
 * Stash the editor's current text with ctrl+s, and pop it back with ctrl+s
 * when the editor is empty. Mirrors Claude Code's prompt stash.
 *
 * - Editor has text and stash is empty  -> stash it, clear the editor.
 * - Editor is empty and stash has text  -> restore it, clear the stash.
 * - Both have text                       -> swap them.
 *
 * The stash is persisted as a custom session entry (excluded from model
 * context), so it survives extension reloads, resume, fork, and clone. On
 * session start the latest entry on the active branch is restored.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "stash";

interface StashData {
	text: string;
}

export default function (pi: ExtensionAPI) {
	let stash = "";

	pi.on("session_start", (_event, ctx) => {
		stash = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				stash = (entry.data as StashData | undefined)?.text ?? "";
			}
		}
	});

	pi.registerShortcut(Key.ctrl("s"), {
		description: "Stash / restore the current prompt",
		handler: (ctx) => {
			if (ctx.mode !== "tui") return;

			const current = ctx.ui.getEditorText();
			const next = stash;
			stash = current;
			ctx.ui.setEditorText(next);
			pi.appendEntry<StashData>(ENTRY_TYPE, { text: stash });

			if (current && next) ctx.ui.notify("Swapped stashed prompt", "info");
			else if (current) ctx.ui.notify("Prompt stashed", "info");
			else if (next) ctx.ui.notify("Prompt restored", "info");
		},
	});
}
