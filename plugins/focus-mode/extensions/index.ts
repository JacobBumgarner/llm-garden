/**
 * Focus mode: collapse every tool call in the transcript to one line with a status-colored glyph.
 *
 * Toggle with /focus or ctrl+shift+o. While on, a tool renderer resolver replaces the renderers of
 * every tool, registered or not, with a strip that shows the summary from `summarize.ts`; a click
 * expands it to the arguments and capped result text. Off, the resolver hands back whatever pi
 * would have used. The transcript, scrolling, images, and search stay pi's own.
 *
 * Thinking blocks stay visible; pi's `hideThinkingBlock` setting (toggled with ctrl+t, or by
 * clicking a run) is the only thing that collapses them, and the extension API offers no per-mode
 * control. Focus mode only relabels the collapsed line to match the tool strips.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { durationLabel, editDiffLines, expansionLines, resultText, type StripColor, stripColor } from "./strip.ts";
import { summarize } from "./summarize.ts";
import type { ToolItem } from "./types.ts";

/** Matches pi's default `outputPad` so strips line up with message text. */
const STRIP_PAD = " ";
const ERROR_SUFFIX = " error";
const ELLIPSIS = "...";
const DONE = "● ";
const RUNNING = "○ ";
/** Collapsed-thinking label glyph: a fold marker, since thinking expands on click. */
const FOLDED = "▸ ";

/** Background role for the strip's lines, keyed by status so a theme may tint by status or not. */
const STRIP_BG: Record<StripColor, "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"> = {
	muted: "toolPendingBg",
	success: "toolSuccessBg",
	error: "toolErrorBg",
};

/** Shared per-call renderer state: the result the strip reads at render time, and render-time timing. */
interface StripState {
	result?: ToolItem["result"];
	expanded?: boolean;
	startedAt?: number;
	endedAt?: number;
}

/** The context fields the renderers read; `ToolRenderContext` itself is not exported by pi. */
interface StripContext {
	state: StripState;
	expanded: boolean;
	isError: boolean;
	executionStarted: boolean;
}

/**
 * One tool call drawn as a strip: summary lines behind a status glyph (hollow while running, filled
 * when done) with the tool name in bold and a duration suffix, then the expansion when open. Collapsed
 * strips have no fill; an expanded strip paints every line full-width in the status background role
 * so the block's extent is visible. An expanded edit shows its diff in the tool diff colors instead
 * of the argument dump.
 */
class Strip implements Component {
	constructor(
		private name: string,
		private args: Record<string, unknown>,
		private state: StripState,
		private theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const item: ToolItem = { name: this.name, args: this.args, result: this.state.result };
		const color = stripColor(item);
		const bg = STRIP_BG[color];
		const inner = Math.max(1, width - STRIP_PAD.length);
		const marker = color === "muted" ? RUNNING : DONE;
		const indent = " ".repeat(marker.length);
		const duration = color === "muted" ? undefined : durationLabel(this.state);
		const body = summarize(item).map((text, i) =>
			i === 0
				? this.summaryLine(text, inner, this.theme.fg(color, marker), marker.length, color, duration)
				: this.summaryLine(text, inner, indent, indent.length),
		);
		if (this.state.expanded) {
			for (const line of this.expansion(item, inner - indent.length)) body.push([indent, line]);
		}
		return body.map((segments) => this.fill(segments, width, this.state.expanded ? bg : undefined));
	}

	/** Styled expansion lines, wrapped to `width`: the colored diff for a finished edit, else the args and result dump. */
	private expansion(item: ToolItem, width: number): string[] {
		const diff = editDiffLines(item);
		if (!diff) {
			return wrapTextWithAnsi(expansionLines(item).join("\n"), width).map((line) => this.theme.fg("muted", line));
		}
		return diff.flatMap((line) => {
			const role = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext";
			return wrapTextWithAnsi(line, width).map((part) => this.theme.fg(role, part));
		});
	}

	/**
	 * Prefix the (already styled) glyph and clip to width, keeping a trailing error marker and duration
	 * visible. With a name color, a leading tool name is drawn bold in that color. Returns segments so
	 * the background can be applied to each, since truncation resets styles.
	 */
	private summaryLine(
		text: string,
		inner: number,
		prefix: string,
		prefixWidth: number,
		nameColor?: StripColor,
		duration?: string,
	): string[] {
		const tail: string[] = [];
		let tailWidth = 0;
		if (text.endsWith(ERROR_SUFFIX)) {
			const marker = ERROR_SUFFIX.trimStart();
			text = text.slice(0, -marker.length);
			tail.push(this.theme.fg("error", marker));
			tailWidth += marker.length;
		}
		if (duration) {
			const suffix = ` · ${duration}`;
			tail.push(this.theme.fg("dim", suffix));
			tailWidth += suffix.length;
		}
		const room = Math.max(0, inner - prefixWidth - tailWidth);
		const body = clip(text, room);
		if (nameColor && (body[0] === this.name || body[0].startsWith(`${this.name} `))) {
			body[0] = this.theme.fg(nameColor, this.theme.bold(this.name)) + body[0].slice(this.name.length);
		}
		return [prefix, ...body, ...tail];
	}

	/** Lead with the pad; with a background, pad to the full width and apply it to every segment. */
	private fill(segments: string[], width: number, bg: (typeof STRIP_BG)[StripColor] | undefined): string {
		if (!bg) return STRIP_PAD + segments.join("");
		const used = STRIP_PAD.length + segments.reduce((sum, segment) => sum + visibleWidth(segment), 0);
		const rest = " ".repeat(Math.max(0, width - used));
		return [STRIP_PAD, ...segments, rest].map((segment) => this.theme.bg(bg, segment)).join("");
	}
}

/** Nothing: the result renderer only records state, the call renderer draws the strip. */
const EMPTY: Component = { render: () => [], invalidate: () => {} };

function clip(text: string, width: number): string[] {
	if (visibleWidth(text) <= width) return [text];
	return [truncateToWidth(text, Math.max(0, width - ELLIPSIS.length), ""), ELLIPSIS];
}

/** Renderers for the mode: the strip on the call slot, state capture on the result slot. */
function focusRenderers(toolName: string, onTheme: (theme: Theme) => void): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (args, theme, context: StripContext) => {
			onTheme(theme);
			context.state.expanded = context.expanded;
			if (context.executionStarted) context.state.startedAt ??= Date.now();
			return new Strip(toolName, (args ?? {}) as Record<string, unknown>, context.state, theme);
		},
		renderResult: (result, options, _theme, context: StripContext) => {
			context.state.result = {
				text: resultText(result.content),
				details: result.details,
				isError: context.isError,
				partial: options.isPartial,
			};
			context.state.expanded = options.expanded;
			if (!options.isPartial) {
				context.state.startedAt ??= Date.now();
				context.state.endedAt ??= Date.now();
			}
			return EMPTY;
		},
	};
}

/** A live renderer set that follows the mode flag, so components built while off still switch. */
function switchable(
	toolName: string,
	base: ToolRenderers | undefined,
	isOn: () => boolean,
	onTheme: (theme: Theme) => void,
): ToolRenderers {
	const focus = focusRenderers(toolName, onTheme);
	return {
		get renderShell() {
			return isOn() ? focus.renderShell : base?.renderShell;
		},
		get renderCall() {
			return isOn() ? focus.renderCall : base?.renderCall;
		},
		get renderResult() {
			return isOn() ? focus.renderResult : base?.renderResult;
		},
	};
}

export default function focusMode(pi: ExtensionAPI): void {
	let on = false;
	let ui: ExtensionUIContext | undefined;
	let swirlTimer: ReturnType<typeof setInterval> | undefined;
	let swirlFrame = 0;

	// Breathing cycle, one tick per frame: dark, sweep waxing to waning, dark, sweep back.
	const DARK = "🌑";
	const SWEEP = ["🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
	const SWIRL_FRAMES = [DARK, ...SWEEP, DARK, ...SWEEP.toReversed()];
	const SWIRL_MS = 1200;

	/** One footer frame: the moon glyph alone. */
	function swirlText(): string {
		return SWIRL_FRAMES[swirlFrame % SWIRL_FRAMES.length]!;
	}

	/** Spin the moon on a timer, calling setStatus on the captured ui object so a stale ctx can't block it. */
	function startSwirl(): void {
		stopSwirl();
		swirlFrame = 0;
		swirlTimer = setInterval(() => {
			swirlFrame++;
			try {
				ui?.setStatus("focus", swirlText());
			} catch {
				stopSwirl();
			}
		}, SWIRL_MS);
	}

	function stopSwirl(): void {
		if (swirlTimer) clearInterval(swirlTimer);
		swirlTimer = undefined;
	}

	pi.registerToolRenderer((toolName, next) => switchable(toolName, next(), () => on, () => {}));

	/** Set the flag, capture the ui object, update the footer, and rebuild tool components. */
	function enable(ctx: ExtensionContext, value: boolean): void {
		on = value;
		ui = ctx.ui;
		if (on) startSwirl();
		else stopSwirl();
		ctx.ui.setStatus("focus", on ? swirlText() : undefined);
		ctx.ui.setHiddenThinkingLabel(on ? `${FOLDED}thinking` : undefined);
		// setToolsExpanded is the one API that re-runs every tool component's renderers; two calls
		// guarantee at least one state change whatever the current expansion, ending collapsed.
		ctx.ui.setToolsExpanded(true);
		ctx.ui.setToolsExpanded(false);
	}

	// Focus is on by default whenever a session is joined, so the strips show before the first turn.
	pi.on("session_start", (_event, ctx) => enable(ctx, true));
	// Fires on reload and session replacement; without it the old instance's timer keeps writing frames.
	pi.on("session_shutdown", () => stopSwirl());

	function toggle(ctx: ExtensionContext): void {
		enable(ctx, !on);
	}


	pi.registerCommand("focus", {
		description: "Toggle focus mode: one line per tool call",
		handler: async (_args, ctx) => toggle(ctx),
	});
	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle focus mode",
		handler: (ctx) => toggle(ctx),
	});
}
