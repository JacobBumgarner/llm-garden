/**
 * Running-subagent badge at the left end and session name at the right end of
 * the editor's top border, on a calm border.
 *
 * Wraps pi's stock editor (with the embedded working indicator on the left of
 * the top border) and paints ` <count> λ ` after the first two columns and
 * ` session-name ` onto the right end of that same line. The badge reads
 * ` <count> λ ? ` in the warning color while a run waits for an answer.
 * Repaints on the `session:name-changed` bus event, on the `subagent:live`
 * event that carries the running subagent runs, and after every turn. A left click on the badge emits `subagent:open`. A second
 * Esc within 1.5 s of the first emits `subagent:stop-all`, and every Esc still
 * reaches pi, so the first press aborts the turn. The three events are the only
 * link to the subagent plugin.
 *
 * pi recolors the border for every thinking level. This editor pins it to
 * `borderMuted` and only lets the bash-mode (`!`) color through.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { createEscapeTimer, ESCAPE_WINDOW_MS } from "./escape.ts";
import { type BadgeSpan, composeTopBorder, hitsBadge, type LiveBadge, parseLive } from "./layout.ts";

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
	let live: LiveBadge = { count: 0, paused: false };
	const escapes = createEscapeTimer(ESCAPE_WINDOW_MS, Date.now);

	const repaint = () => activeTui?.requestRender();
	pi.events.on("session:name-changed", repaint);
	pi.on("agent_settled", repaint);
	pi.events.on("subagent:live", (data) => {
		live = parseLive(data);
		repaint();
	});

	pi.on("session_shutdown", () => {
		activeTui = undefined;
	});

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;

		class SessionTitleEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { embedWorkingStatus: true });
				this.appKeybindings = keybindings;
				activeTui = tui;
				pinBorder(this, ctx);
			}

			private badgeSpan: BadgeSpan | undefined;
			private readonly appKeybindings: KeybindingsManager;

			handleInput(data: string): void {
				if (this.appKeybindings.matches(data, "app.interrupt") && !this.isShowingAutocomplete() && escapes.press()) {
					pi.events.emit("subagent:stop-all", undefined);
				}
				super.handleInput(data);
			}

			render(width: number): string[] {
				const lines = super.render(width);
				this.badgeSpan = undefined;
				if (lines.length < 2) return lines;

				const theme = ctx.ui.theme;
				const top = composeTopBorder(lines[0], width, pi.getSessionName(), live, {
					badge: (text) => theme.fg("accent", text),
					warning: (text) => theme.fg("warning", text),
					name: (text) => theme.fg("muted", text),
					border: (text) => this.borderColor(text),
				});
				lines[0] = top.line;
				this.badgeSpan = top.badge;
				return lines;
			}

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				// pi enables mouse tracking in fullscreen mode only, so the badge is inert elsewhere.
				if (event.type === "click" && event.button === "left" && hitsBadge(this.badgeSpan, event.x, event.y)) {
					pi.events.emit("subagent:open", undefined);
					return { handled: true };
				}
				return super.handleMouse(event);
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SessionTitleEditor(tui, theme, keybindings));
	});
}
