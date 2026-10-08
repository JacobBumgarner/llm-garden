/**
 * Session name in the editor's top border, right-aligned, on a calm border.
 *
 * Wraps pi's stock editor (with the embedded working indicator on the left of
 * the top border) and paints ` session-name ` onto the right end of that same
 * line. Repaints when the name changes via the `session:name-changed` bus
 * event (emitted by rename.ts) and after every turn.
 *
 * pi recolors the border for every thinking level; this editor pins it to
 * `borderMuted` and only lets the bash-mode (`!`) color through.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_GAP = 6;

type Paint = (text: string) => string;

/**
 * Replace the editor's own `borderColor` field with an accessor that ignores pi's per-thinking-level
 * colors. Bash mode is recognized by its paint and kept.
 */
function pinBorder(editor: CustomEditor, ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	const calm: Paint = (text) => theme.fg("borderMuted", text);
	const bashProbe = theme.fg("bashMode", "x");
	let current: Paint = calm;
	Object.defineProperty(editor, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => current,
		set: (paint: Paint | undefined) => {
			current = paint && paint("x") === bashProbe ? paint : calm;
		},
	});
}

export default function (pi: ExtensionAPI) {
	let activeTui: TUI | undefined;

	const repaint = () => activeTui?.requestRender();
	pi.events.on("session:name-changed", repaint);
	pi.on("agent_settled", repaint);

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		class SessionTitleEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { embedWorkingStatus: true });
				activeTui = tui;
				pinBorder(this, ctx);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				const name = pi.getSessionName();
				if (!name || lines.length < 2) return lines;

				const label = ` ${name} `;
				const tail = 2;
				const keep = width - visibleWidth(label) - tail;
				if (keep < MIN_GAP) return lines;

				lines[0] =
					truncateToWidth(lines[0], keep, "") +
					ctx.ui.theme.fg("muted", label) +
					this.borderColor("─".repeat(tail));
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SessionTitleEditor(tui, theme, keybindings));
	});
}
