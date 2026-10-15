/**
 * Focus mode: keep tool calls out of the way of the conversation.
 *
 * Three modes, cycled with /focus or ctrl+shift+o (or set with `/focus hidden|strips|off`;
 * `/focus hidden turn|step` also picks the counter placement):
 *
 * - `hidden` (the default): tool calls do not render at all, except the subagent tool, which draws
 *   as its one-line strip so delegations stay visible. Each turn's other calls stand behind one
 *   counter line (`● 4 actions`). Where it goes is the placement, set with `/focus hidden turn|step`:
 *   `step` (the default) draws one counter after each run of calls between pieces of assistant
 *   text, so the transcript shows when the agent acted; `turn` draws it where the latest call is
 *   while the turn runs, so it follows the bottom of the agent's output, then moves it below the
 *   final response as a session entry not sent to the model (resumed sessions show those entries).
 *   alt+t or /actions opens a centered modal panel that streams every call with its status,
 *   duration, and the tail of its output under a header carrying the prompt that started the turn,
 *   with a dashed rule between steps; a click on a counter opens it scrolled to that counter's
 *   calls. It follows new calls while scrolled to the end, pans sideways, and a drag inside it
 *   copies the selected text.
 * - `strips`: a tool renderer resolver replaces the renderers of every tool, registered or not, with
 *   a strip that shows the summary from `summarize.ts`; a click expands it to the arguments and
 *   capped result text (the colored diff for an edit). A running strip redraws once a second so its
 *   elapsed time and any streamed progress stay current; a finished one shows the duration pi
 *   recorded.
 * - `off`: the resolver hands back whatever pi would have used.
 *
 * The action log behind the counter and the panel is fed by pi's tool execution events and seeded
 * from the session branch on join, so resumed sessions list their past calls too. The transcript,
 * scrolling, images, and search stay pi's own.
 *
 * Thinking blocks stay visible; pi's `hideThinkingBlock` setting (toggled with ctrl+t, or by
 * clicking a run) is the only thing that collapses them, and the extension API offers no per-mode
 * control. Focus mode only relabels the collapsed line to match the tool strips.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { ActionLog, type GroupCount, hasText, labelFor } from "./log.ts";
import { ActionsPanel, PANEL_MIN_WIDTH, PANEL_WIDTH, type PanelTarget } from "./panel.ts";
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

/** How often a running strip redraws so its elapsed time ticks. */
const TICK_MS = 1000;

export type FocusLevel = "hidden" | "strips" | "off";
const LEVELS: FocusLevel[] = ["hidden", "strips", "off"];
/** Where hidden mode draws the counter: once per turn, or once per assistant message. */
export type Placement = "turn" | "step";
const PLACEMENTS: Placement[] = ["turn", "step"];
/** Tools that stay visible as strips in hidden mode and are left out of the counter. */
const VISIBLE_TOOLS = ["subagent"];
const PANEL_KEY = "alt+t";
/** Session entry type holding a finished turn's counts. */
const COUNT_ENTRY = "focus-actions";

interface CountEntryData {
	total: number;
	errors: number;
	added?: number;
	removed?: number;
	/** The turn the counts belong to, so a click opens the panel scrolled to it. */
	group?: number;
}

/**
 * Shared per-call renderer state: the result the strip reads at render time, when execution was first
 * seen running, and the final duration pi recorded for the call.
 */
interface StripState {
	result?: ToolItem["result"];
	expanded?: boolean;
	startedAt?: number;
	durationMs?: number;
}

/** The context fields the renderers read; `ToolRenderContext` itself is not exported by pi. */
interface StripContext {
	toolCallId: string;
	state: StripState;
	expanded: boolean;
	isError: boolean;
	executionStarted: boolean;
	durationMs: number | undefined;
	invalidate: () => void;
}

/** Elapsed time to show: the recorded duration once final, else the wall clock since execution began. */
function elapsedMs(state: StripState): number | undefined {
	if (state.durationMs !== undefined) return state.durationMs;
	if (state.startedAt === undefined) return undefined;
	return Date.now() - state.startedAt;
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
		const duration = durationLabel(elapsedMs(this.state));
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

/**
 * The one line a turn's hidden calls leave in the transcript: a status glyph (hollow while any call
 * runs, filled once done), the count, an error count when any call failed, and the key that opens the panel.
 * A left click on the line opens the panel scrolled to the calls it stands for.
 */
class Counter implements Component {
	private count: () => GroupCount;
	private theme: Theme;
	private onClick: () => void;

	constructor(count: () => GroupCount, theme: Theme, onClick: () => void) {
		this.count = count;
		this.theme = theme;
		this.onClick = onClick;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return [counterLine(this.count(), this.theme, width)];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return counterClick(event, this.onClick);
	}
}

/** Open the panel on a primary click; leave every other event (wheel, drag selection) to pi. */
function counterClick(event: TuiMouseEvent, open: () => void): TuiMouseEventResult | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	open();
	return { handled: true };
}

/**
 * The counter text: glyph (hollow while any call runs, filled once done), count, error count if any,
 * lines added/removed by edits if any, panel key.
 */
function counterLine({ total, running, errors, added, removed }: GroupCount, theme: Theme, width: number): string {
	const color: StripColor = running > 0 ? "muted" : "success";
	const marker = running > 0 ? RUNNING : DONE;
	const label = `${total} action${total === 1 ? "" : "s"}`;
	const sep = theme.fg("dim", " · ");
	const failed = errors > 0 ? sep + theme.fg("error", `${errors} error${errors === 1 ? "" : "s"}`) : "";
	const diff =
		added > 0 || removed > 0
			? sep + theme.fg("toolDiffAdded", `+${added}`) + " " + theme.fg("toolDiffRemoved", `-${removed}`)
			: "";
	const text = STRIP_PAD + theme.fg(color, marker) + label + failed + diff + theme.fg("dim", ` · ${PANEL_KEY}`);
	return truncateToWidth(text, width, "");
}

function clip(text: string, width: number): string[] {
	if (visibleWidth(text) <= width) return [text];
	return [truncateToWidth(text, Math.max(0, width - ELLIPSIS.length), ""), ELLIPSIS];
}

/**
 * One redraw interval per running tool call, so a strip's elapsed time ticks between result updates.
 * A ticker stops when the call's final result renders, when pi reports the execution ended, or when
 * the session shuts down; `stopAll` covers components that were dropped without a final render.
 */
class Tickers {
	private timers = new Map<string, ReturnType<typeof setInterval>>();

	start(toolCallId: string, invalidate: () => void): void {
		if (this.timers.has(toolCallId)) return;
		this.timers.set(toolCallId, setInterval(invalidate, TICK_MS));
	}

	stop(toolCallId: string): void {
		const timer = this.timers.get(toolCallId);
		if (timer) clearInterval(timer);
		this.timers.delete(toolCallId);
	}

	stopAll(): void {
		for (const id of [...this.timers.keys()]) this.stop(id);
	}
}

/** Renderers for the mode: the strip on the call slot, state capture on the result slot. */
function focusRenderers(toolName: string, tickers: Tickers, onTheme: (theme: Theme) => void): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (args, theme, context: StripContext) => {
			onTheme(theme);
			context.state.expanded = context.expanded;
			const running = context.state.result === undefined || context.state.result.partial === true;
			if (context.executionStarted && running) {
				context.state.startedAt ??= Date.now();
				tickers.start(context.toolCallId, context.invalidate);
			}
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
				tickers.stop(context.toolCallId);
				context.state.durationMs ??=
					context.durationMs ?? (context.state.startedAt === undefined ? undefined : Date.now() - context.state.startedAt);
			}
			return EMPTY;
		},
	};
}

/**
 * Renderers for hidden mode: the call slot draws the group counter on the group's latest call, so
 * the line sits under the agent's most recent output while the turn runs, and nothing elsewhere;
 * the result slot draws nothing. Both only read the log. Every write comes from pi's tool events,
 * since a renderer that wrote would notify, redraw, and run again without end. Each call's redraw
 * hook is recorded so a log change can refresh every component of the group.
 */
function hiddenRenderers(
	log: ActionLog,
	redraws: Map<string, () => void>,
	placement: () => Placement,
	openPanel: (target: PanelTarget) => void,
): ToolRenderers {
	return {
		renderShell: "self",
		renderCall: (_args, theme, context: StripContext) => {
			redraws.set(context.toolCallId, context.invalidate);
			const entry = log.get(context.toolCallId);
			if (!entry) return EMPTY;
			if (placement() === "step") {
				return log.isStepTail(entry.id)
					? new Counter(() => log.stepCount(entry.step), theme, () => openPanel({ step: entry.step }))
					: EMPTY;
			}
			return log.isGroupTail(entry.id)
				? new Counter(() => log.groupCount(entry.group), theme, () => openPanel({ group: entry.group }))
				: EMPTY;
		},
		renderResult: () => EMPTY,
	};
}

/** A live renderer set that follows the current level, so components built under one level still switch. */
function switchable(
	toolName: string,
	base: ToolRenderers | undefined,
	tickers: Tickers,
	level: () => FocusLevel,
	log: ActionLog,
	redraws: Map<string, () => void>,
	placement: () => Placement,
	onTheme: (theme: Theme) => void,
	openPanel: (target: PanelTarget) => void,
): ToolRenderers {
	const strips = focusRenderers(toolName, tickers, onTheme);
	const hidden = VISIBLE_TOOLS.includes(toolName) ? strips : hiddenRenderers(log, redraws, placement, openPanel);
	const pick = (): ToolRenderers | undefined => {
		switch (level()) {
			case "hidden":
				return hidden;
			case "strips":
				return strips;
			case "off":
				return base;
		}
	};
	return {
		get renderShell() {
			return pick()?.renderShell;
		},
		get renderCall() {
			return pick()?.renderCall;
		},
		get renderResult() {
			return pick()?.renderResult;
		},
	};
}

export default function focusMode(pi: ExtensionAPI): void {
	let level: FocusLevel = "off";
	let placement: Placement = "step";
	let ui: ExtensionUIContext | undefined;
	const log = new ActionLog(VISIBLE_TOOLS);
	/** Redraw hook of each hidden tool component, keyed by tool call id. */
	const redraws = new Map<string, () => void>();
	let panelOpen = false;
	let closePanel: (() => void) | undefined;
	let redrawPanel: (() => void) | undefined;
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

	const tickers = new Tickers();
	pi.registerToolRenderer((toolName, next) =>
		switchable(toolName, next(), tickers, () => level, log, redraws, () => placement, () => {}, openPanelFromClick),
	);

	log.onChange((entry) => {
		for (const id of log.groupIds(entry.group)) redraws.get(id)?.();
		redrawPanel?.();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user") log.nextGroup(labelFor(event.message.content));
	});
	// An assistant message's calls run after it ends, so a text message's calls open the step that
	// follows its text; tool-only messages leave the step alone and their calls join the same counter.
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && hasText(event.message.content)) log.nextStep();
	});
	// With turn placement the counter moves below the final response: append it as an entry and
	// retire the in-flight line by closing the group.
	pi.on("agent_end", () => {
		if (placement !== "turn") return;
		const group = log.currentGroup;
		if (log.isClosed(group)) return;
		const { total, errors, added, removed } = log.groupCount(group);
		log.closeGroup(group);
		for (const id of log.groupIds(group)) redraws.get(id)?.();
		if (total > 0) pi.appendEntry<CountEntryData>(COUNT_ENTRY, { total, errors, added, removed, group });
	});
	pi.registerEntryRenderer<CountEntryData>(COUNT_ENTRY, (entry, _options, theme) => {
		const data = entry.data ?? { total: 0, errors: 0 };
		if (level !== "hidden" || placement !== "turn" || data.total === 0) return EMPTY;
		const count: GroupCount = { ...data, running: 0, added: data.added ?? 0, removed: data.removed ?? 0 };
		return {
			invalidate: () => {},
			render: (width: number) => [counterLine(count, theme, width)],
			handleMouse: (event: TuiMouseEvent) =>
				counterClick(event, () => openPanelFromClick(data.group === undefined ? undefined : { group: data.group })),
		};
	});
	pi.on("tool_execution_start", (event) => {
		log.start(event.toolCallId, event.toolName, (event.args ?? {}) as Record<string, unknown>, event.parentToolCallId);
	});
	pi.on("tool_execution_update", (event) => {
		const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
		if (!partial) return;
		log.result(event.toolCallId, { text: resultText(partial.content), details: partial.details, isError: false, partial: true });
	});
	pi.on("tool_execution_end", (event) => {
		tickers.stop(event.toolCallId);
		const result = event.result as { content?: unknown; details?: unknown } | undefined;
		log.result(
			event.toolCallId,
			{ text: resultText(result?.content), details: result?.details, isError: event.isError },
			event.durationMs,
		);
	});

	/** Set the level, capture the ui object, update the footer, and rebuild tool components. */
	function setLevel(ctx: ExtensionContext, value: FocusLevel): void {
		level = value;
		ui = ctx.ui;
		const on = level !== "off";
		if (on) startSwirl();
		else stopSwirl();
		ctx.ui.setStatus("focus", on ? swirlText() : undefined);
		ctx.ui.setHiddenThinkingLabel(on ? `${FOLDED}thinking` : undefined);
		// setToolsExpanded is the one API that re-runs every tool component's renderers; two calls
		// guarantee at least one state change whatever the current expansion, ending collapsed.
		ctx.ui.setToolsExpanded(true);
		ctx.ui.setToolsExpanded(false);
	}

	function cycle(ctx: ExtensionContext): void {
		setLevel(ctx, LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length]!);
	}

	/** Open the panel from a counter click: the ui object captured when the level was last set. */
	function openPanelFromClick(target?: PanelTarget): void {
		if (ui) void openPanel(ui, target);
	}

	/** Open the panel, scrolled to `target` when given; a second call while open closes it. */
	async function openPanel(target: ExtensionUIContext, scrollTo?: PanelTarget): Promise<void> {
		if (panelOpen) {
			closePanel?.();
			return;
		}
		panelOpen = true;
		try {
			await target.custom<void>(
				(tui, theme, _keybindings, done) => {
					const panel = new ActionsPanel({
						entries: () => log.visible(),
						groups: () => log.groups(),
						label: (group) => log.label(group),
						target: scrollTo,
						rows: () => tui.terminal.rows,
						requestRender: () => tui.requestRender(),
						theme,
						terminal: tui.terminal,
						done: () => done(),
					});
					closePanel = () => done();
					redrawPanel = () => tui.requestRender();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: PANEL_WIDTH, minWidth: PANEL_MIN_WIDTH },
				},
			);
		} finally {
			panelOpen = false;
			closePanel = undefined;
			redrawPanel = undefined;
		}
	}

	// Hidden is the default whenever a session is joined; the branch seeds the log so the counters
	// and panel cover calls made before this process.
	pi.on("session_start", (_event, ctx) => {
		log.seed(ctx.sessionManager.getBranch());
		setLevel(ctx, "hidden");
	});
	// Fires on reload and session replacement; without it the old instance's timer keeps writing frames.
	pi.on("session_shutdown", () => {
		stopSwirl();
		tickers.stopAll();
		closePanel?.();
	});

	pi.registerCommand("focus", {
		description: "Cycle focus mode (hidden → strips → off), or set it: /focus hidden [turn|step] | strips | off",
		handler: async (args, ctx) => {
			const [wanted = "", option = ""] = (args ?? "").trim().split(/\s+/);
			if (!wanted) cycle(ctx);
			else if (!LEVELS.includes(wanted as FocusLevel)) {
				return ctx.ui.notify(`Unknown focus mode "${wanted}". Use hidden [turn|step], strips, or off.`, "error");
			} else {
				if (wanted === "hidden" && option) {
					if (!PLACEMENTS.includes(option as Placement)) {
						return ctx.ui.notify(`Unknown placement "${option}". Use turn or step.`, "error");
					}
					placement = option as Placement;
				}
				setLevel(ctx, wanted as FocusLevel);
			}
			ctx.ui.notify(level === "hidden" ? `focus: hidden · counter per ${placement}` : `focus: ${level}`, "info");
		},
	});
	pi.registerShortcut("ctrl+shift+o", {
		description: "Cycle focus mode",
		handler: (ctx) => cycle(ctx),
	});
	pi.registerCommand("actions", {
		description: "Open the actions panel: every tool call this session",
		handler: async (_args, ctx) => {
			if (ctx.mode === "tui") await openPanel(ctx.ui);
		},
	});
	pi.registerShortcut(PANEL_KEY, {
		description: "Open the actions panel",
		handler: (ctx) => {
			if (ctx.mode === "tui") void openPanel(ctx.ui);
		},
	});
}
