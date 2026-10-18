/**
 * Live view: the `subagent:live` event that publishes the running runs, the
 * `/subagents` overlay (the shared overlay draws its frame) that lists every run of the
 * session, running runs above finished ones under headers that always draw,
 * scrolling the list through a viewport to fit the height pi gives the overlay, with keys to
 * stop, steer, or answer the selected one, or open its actions panel (the
 * focus-mode panel over the run's own tool calls). A click on a run row
 * selects it and opens its actions panel, and a drag selects text and copies
 * it to the clipboard, as in the aside panel, scrolling on while the pointer is held past the
 * top or bottom edge. The list pans sideways
 * with ←/→ (or shift+wheel) to read long labels, `0` pans back,
 * PgUp/PgDn, Home/End, and the wheel move the selection. The stop-all paths:
 * `/subagents stop`, the overlay `s` key, and a double Esc, which arrives as
 * the `subagent:stop-all` event. The `alt+a` shortcut and bare `/subagents`
 * toggle the overlay, the `subagent:open` event only opens it, and a click
 * outside the box closes it. Dialogs and the overlay draw in
 * the terminal UI only, because RPC mode forwards every dialog to the parent.
 * The overlay component takes its dependencies as parameters, so its key
 * handling runs without a terminal.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, stripTerminalSequences, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CopyFeedback } from "../../shared/copy-feedback.ts";
import { openOverlay, OverlaySlot } from "../../shared/overlay.ts";
import { cellAt, DragAutoScroll, highlightSelection, type PaintedText, TextSelection } from "../../shared/selection.ts";
import { Viewport } from "../../shared/viewport.ts";
import type { AskQuestion } from "../../ask/api.ts";
import { ActionLog, ActionsPanel, PANEL_MIN_WIDTH, PANEL_WIDTH } from "../../focus-mode/api.ts";
import {
	formatOverlayRow,
	layoutOverlay,
	type OverlayEntry,
	type OverlayPaint,
	overlayRowWidth,
	overlayStateColor,
} from "./format.ts";
import { isLive } from "./registry.ts";
import type { Run } from "./types.ts";

export const LIVE_EVENT = "subagent:live";
export const OPEN_EVENT = "subagent:open";
export const STOP_ALL_EVENT = "subagent:stop-all";
export const NOTE_MESSAGE_TYPE = "subagent-note";
export const REFRESH_MS = 5000;
const ACTIONS_REFRESH_MS = 1000;
export const TOGGLE_KEY = "alt+a";
const OVERLAY_TITLE = " subagents ";
const ROW_INDENT = 2;
const OVERLAY_HEIGHT_FRACTION = 0.6;
const BOX_EDGES = 2;
/** The leading blank, the blank above the help line, and the help line. */
const FIXED_LINES = 3;
/** Rows of the leading blank above the scrolling body. */
const BODY_TOP = 1;
const HELP_LINE = "↑↓ select · ←→ pan · s stop · m message · a answer · esc or alt+a close";
/** Columns one ← or → key (or one shift+wheel tick) pans, matching the actions panel. */
export const PAN_STEP = 8;

/** The registry surface the live view reads and drives. A `RunRegistry` satisfies it. */
export interface ViewRegistry {
	on(event: "change", fn: (run: Run) => void): () => void;
	list(): Run[];
	stop(id: string): Promise<void>;
	stopAll(): Promise<void>;
	send(id: string, text: string, mode: "steer" | "follow_up"): Promise<string>;
	resume(id: string, input: { answers: Record<string, string> }): Promise<Run>;
}

export type ViewContext = Pick<ExtensionContext, "mode" | "ui">;

/** The run summary carried by the `subagent:live` event. */
export interface LiveRun {
	id: string;
	agent: string;
	label: string;
	state: Run["state"];
}

/**
 * Emit `subagent:live` with the queued, running, and paused runs on every
 * registry change, answer `subagent:open` by opening the overlay, and answer
 * `subagent:stop-all` by confirming and stopping every running run. Both answers
 * use the context from `getCtx` and apply in the terminal UI only. Return the
 * dispose function, which unsubscribes and emits an empty list.
 */
export function createLiveView(
	pi: Pick<ExtensionAPI, "events" | "sendMessage">,
	registry: ViewRegistry,
	getCtx: () => ExtensionContext | undefined,
): () => void {
	const publish = () => {
		const runs: LiveRun[] = registry
			.list()
			.filter(isLive)
			.map(({ id, agent, label, state }) => ({ id, agent, label, state }));
		pi.events.emit(LIVE_EVENT, { count: runs.length, runs });
	};
	const inTui = (handle: (ctx: ExtensionContext) => Promise<void>) => () => {
		const ctx = getCtx();
		if (ctx?.mode === "tui") void handle(ctx);
	};
	const stopAll = createStopAllHandler(() => registry);
	const unsubscribe = registry.on("change", publish);
	const unsubscribeOpen = pi.events.on(OPEN_EVENT, inTui((ctx) => openRunList(pi, registry, ctx)));
	const unsubscribeStopAll = pi.events.on(STOP_ALL_EVENT, inTui(stopAll));
	publish();
	return () => {
		unsubscribe();
		unsubscribeOpen();
		unsubscribeStopAll();
		pi.events.emit(LIVE_EVENT, { count: 0, runs: [] });
	};
}

/** Return the lines left for list entries: the overlay's share of `rows`, minus the box edges, the fixed lines, and `noticeLines`. */
function visibleRows(rows: number, noticeLines: number): number {
	return Math.max(1, Math.floor(rows * OVERLAY_HEIGHT_FRACTION) - BOX_EDGES - FIXED_LINES - noticeLines);
}

/** The dialogs the overlay opens. `ctx.ui` satisfies it. */
export interface ViewDialogs {
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** What the overlay needs from its host. */
export interface RunListDeps {
	registry: ViewRegistry;
	dialogs: ViewDialogs;
	/** Post a note into the orchestrator's session for its next turn. */
	postNote: (content: string) => void;
	close: () => void;
	requestRender: () => void;
	/** Run a dialog with the overlay out of the way, then bring the overlay back with focus. */
	suspend: <T>(dialog: () => Promise<T>) => Promise<T>;
	/** Open the actions panel for a run and resolve when it closes. Absent outside the terminal UI. */
	showActions?: (run: Run) => Promise<void>;
	now: () => number;
	/** The terminal height in rows, which the overlay's height cap is a fraction of. */
	rows: () => number;
	/** Style the selected row. */
	highlight: (text: string) => string;
	/** Color the icon and state word of an unselected row by the run state. */
	paint: OverlayPaint;
	/** Style the key line, headers, and empty-group lines. */
	dim: (text: string) => string;
	/** Style the `copied` label that stands in for the key line after a copy. */
	success: (text: string) => string;
	/** Paint a selected span of text, in inverse video. */
	inverse: (text: string) => string;
	/** Put dragged text on the clipboard. Defaults to `copyToClipboard` through `terminal`. */
	copy?: (text: string) => void;
	/** The terminal the default clipboard copy writes OSC 52 to. Unused when `copy` is given. */
	terminal?: { write(data: string): void };
}

type RunAction = (run: Run) => Promise<void>;

/**
 * Overlay component listing the running runs, then the finished runs, each
 * newest first, with a dim header titling each group and a dim `(none)` line
 * under an empty one. Unselected rows paint the icon and state word by state,
 * and the selected row takes the highlight alone. The arrow keys move a
 * selection over runs and skip headers, gaps, and `(none)` lines. Keys act on
 * the selected run: space opens its actions panel, `s` stops it after a
 * confirm, `m` steers it, `a` answers a paused run, esc closes. Every entry is
 * painted, and a viewport scrolls them to fit the overlay's height, moving the
 * least that keeps the selected run in view. PgUp/PgDn move the selection by a page,
 * Home/End to the first and last run, and the wheel by one run a tick.
 * Rows wider than the overlay pan sideways with ←/→ or shift+wheel, by
 * `PAN_STEP` columns, up to the widest row's end; `0` pans back. The help
 * line reports the pan while one is in effect. Mouse rows arrive relative to
 * the text area, so a press on the run row drawn on line `y` of `render` selects the run, and a left click on one opens its actions panel.
 * A drag from a press highlights the text it covers in inverse video and
 * copies it on release. A drag held past the top or bottom of the list scrolls it
 * and keeps selecting. The help line reads `copied` for a moment after, as
 * in the actions panel. The highlight stays until the next press or key.
 */
export class RunListView {
	private selected = 0;
	private readonly viewport = new Viewport();
	/** Set when the selection moved, so the next render scrolls it into view. Scrolling the view by hand clears it. */
	private follow = true;
	private pan = 0;
	private notice: string | undefined;
	private busy: Promise<void> | undefined;
	/** The run drawn on each body line of the last render, by line index, with undefined for the other lines. */
	private lineRuns: (Run | undefined)[] = [];
	/** The whole body of the last render, unstyled, for mapping the pointer to text. */
	private painted: PaintedText = { lines: [], x: 0, y: 0, width: 0, height: 0, top: 0, pan: 0 };
	private readonly selection = new TextSelection();
	private readonly feedback: CopyFeedback;
	private readonly autoScroll = new DragAutoScroll({
		scrollBy: (lines) => {
			this.follow = false;
			this.viewport.scrollBy(lines);
		},
		onTick: () => this.autoScrollTick(),
	});
	private readonly deps: RunListDeps;
	private readonly unsubscribe: () => void;

	constructor(deps: RunListDeps) {
		this.deps = deps;
		this.feedback = new CopyFeedback({
			requestRender: deps.requestRender,
			terminal: deps.terminal,
			copy: deps.copy,
			now: deps.now,
		});
		this.unsubscribe = deps.registry.on("change", () => {
			this.clamp();
			deps.requestRender();
		});
	}

	/** Stop listening to the registry. */
	dispose(): void {
		this.unsubscribe();
		this.autoScroll.dispose();
		this.feedback.dispose();
	}

	/** Re-lay out after an auto-scroll step and pull the selection's focus to the cell under the held pointer. */
	private autoScrollTick(): void {
		const pointer = this.autoScroll.pointer;
		this.painted.top = this.viewport.layout(this.painted.lines.length, this.painted.height);
		if (pointer) this.selection.extend(cellAt(this.painted, pointer.x, pointer.y, true));
		this.deps.requestRender();
	}

	/** Show `message` above the key line until the next key. */
	showNotice(message: string): void {
		this.notice = message;
		this.deps.requestRender();
	}

	/** Resolve once the action started by the last key has finished. */
	async settled(): Promise<void> {
		await this.busy;
	}

	private entries(): OverlayEntry[] {
		return layoutOverlay(this.deps.registry.list());
	}

	/** The selectable runs, in overlay order. */
	private runs(): Run[] {
		return this.entries().flatMap((entry) => (entry.kind === "run" ? [entry.run] : []));
	}

	private selectedRun(): Run | undefined {
		return this.runs()[this.selected];
	}

	private clamp(): void {
		this.selected = Math.min(this.selected, Math.max(0, this.runs().length - 1));
	}

	/** Indent `text` under the headers and dim it. */
	private dimLine(text: string): string {
		return `${" ".repeat(ROW_INDENT)}${this.deps.dim(text)}`;
	}

	render(width: number): string[] {
		const selected = this.selectedRun();
		const pad = " ".repeat(ROW_INDENT);
		const entries = this.entries();
		const notice = this.notice === undefined ? [] : [`${pad}${this.notice}`];
		const rowWidth = width - ROW_INDENT;
		this.pan = Math.min(this.pan, this.maxPan(entries, rowWidth));
		const body = entries.map((entry) => {
			if (entry.kind === "gap") return "";
			if (entry.kind === "header") return this.dimLine(entry.title);
			if (entry.kind === "none") return this.dimLine("(none)");
			return `${pad}${this.row(entry.run, entry.run === selected, rowWidth)}`;
		});
		this.lineRuns = entries.map((entry) => (entry.kind === "run" ? entry.run : undefined));
		const height = Math.min(body.length, visibleRows(this.deps.rows(), notice.length));
		const top = this.layoutViewport(body.length, height, this.lineRuns.indexOf(selected));
		const plain = body.map(stripTerminalSequences);
		this.painted = { lines: plain, x: 0, y: BODY_TOP, width, height, top, pan: 0 };
		const visible = body
			.slice(top, top + height)
			.map((line, index) => highlightSelection(line, top + index, width, this.selection.current, this.deps.inverse));
		return ["", ...visible, ...notice, "", this.statusLine()];
	}

	/** Scroll the viewport the least that shows `selectedLine` when the selection just moved, then clamp it. Return the first visible line. */
	private layoutViewport(bodyHeight: number, height: number, selectedLine: number): number {
		const { viewport } = this;
		viewport.pinned = false;
		if (this.follow && selectedLine >= 0) {
			if (selectedLine < viewport.top) viewport.top = selectedLine;
			else if (selectedLine >= viewport.top + height) viewport.top = selectedLine - height + 1;
			if (this.selected === 0 && selectedLine < height) viewport.top = 0;
		}
		this.follow = false;
		return viewport.layout(bodyHeight, height);
	}

	/** The farthest pan that still shows the end of the widest row inside `width` columns (after the `> ` marker). */
	private maxPan(entries: OverlayEntry[], width: number): number {
		const fit = Math.max(width - 2, 1);
		const now = this.deps.now();
		let widest = 0;
		for (const entry of entries) {
			if (entry.kind === "run") widest = Math.max(widest, overlayRowWidth(entry.run, now));
		}
		return Math.max(0, widest - fit);
	}

	/** Render a row at its natural width, or the panned width when that is wider, and show the `fit` columns from the pan. The `> ` marker stays put. */
	private row(run: Run, selected: boolean, width: number): string {
		const fit = Math.max(width - 2, 1);
		const now = this.deps.now();
		const panned = (text: string) => sliceByColumn(text, this.pan, fit);
		// unpainted: theme.fg resets the foreground at its end, which would cut the highlight short
		if (selected) return this.deps.highlight(`> ${panned(formatOverlayRow(run, now, fit + this.pan))}`);
		return `  ${panned(formatOverlayRow(run, now, fit + this.pan, this.deps.paint))}`;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		this.notice = undefined;
		this.selection.clear();
		this.autoScroll.stop();
		// The focused overlay owns input, so pi's shortcut router never sees the toggle chord while it is open.
		if (matchesKey(data, "escape") || matchesKey(data, TOGGLE_KEY)) return this.deps.close();
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "pageUp")) return this.moveTo(this.selected - this.pageSize());
		if (matchesKey(data, "pageDown")) return this.moveTo(this.selected + this.pageSize());
		if (matchesKey(data, "home")) return this.moveTo(0);
		if (matchesKey(data, "end")) return this.moveTo(Number.POSITIVE_INFINITY);
		if (matchesKey(data, "left")) return this.panBy(-PAN_STEP);
		if (matchesKey(data, "right")) return this.panBy(PAN_STEP);
		if (data === "0") return this.panBy(Number.NEGATIVE_INFINITY);
		if (matchesKey(data, "space")) return this.act(this.actions);
		if (matchesKey(data, "s")) return this.act(this.stop);
		if (matchesKey(data, "m")) return this.act(this.message);
		if (matchesKey(data, "a")) return this.act(this.answer);
	}

	/**
	 * Wheel moves the selection one run a tick; shift+wheel pans, wheel-up panning right so a
	 * trackpad swipe tracks the content. A press on a run row selects it, and a left click on
	 * one opens its actions panel. A press also anchors a text selection, which a drag grows and
	 * a release copies; pi sends no click after a drag, so a drag never opens the panel. Other
	 * presses and clicks are swallowed so they do not reach the editor behind the overlay.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			if (this.busy) return { handled: true };
			const delta = Math.sign(event.wheelDelta ?? 0);
			if (delta === 0) return { handled: true };
			if (event.shift) this.panBy(-delta * PAN_STEP);
			else this.moveTo(this.selected + delta);
			return { handled: true, render: true };
		}
		if (this.selection.dragging) {
			const { result, copy } = this.selection.drag(event, (x, y, edges) => cellAt(this.painted, x, y, edges), this.painted.lines);
			if (copy !== undefined) this.feedback.copy(copy);
			if (!this.selection.dragging) this.autoScroll.stop();
			else if (event.type === "drag" || event.type === "move") {
				this.autoScroll.update(event, this.painted.y, this.painted.y + this.painted.height - 1);
			}
			return result;
		}
		if (event.type !== "press" && event.type !== "click") return { handled: true };
		if (this.busy) return { handled: true };
		if (event.type === "press") {
			const cell = event.button === "left" ? cellAt(this.painted, event.x, event.y, false) : undefined;
			this.selection.press(cell);
			const index = this.runIndexAt(event.y);
			if (index !== undefined) {
				this.notice = undefined;
				this.moveTo(index);
			}
			return { capture: cell !== undefined, handled: true, render: true };
		}
		if (event.button === "left" && (event.clickCount ?? 1) >= 2) {
			const cell = cellAt(this.painted, event.x, event.y, false);
			if (cell) this.feedback.copy(this.selection.selectClicks(this.painted.lines, cell, event.clickCount ?? 2));
			return { handled: true, render: true };
		}
		const index = this.runIndexAt(event.y);
		if (index === undefined) return { handled: true };
		this.notice = undefined;
		this.moveTo(index);
		if (event.button === "left") this.act(this.actions);
		return { handled: true, render: true };
	}

	/** The last row: `copied` for a moment after a drag copies text, else the key line with the pan in front while one is in effect. */
	private statusLine(): string {
		if (this.feedback.active()) return this.deps.success("copied");
		return this.deps.dim(this.pan > 0 ? `→ ${this.pan} · ${HELP_LINE}` : HELP_LINE);
	}

	/** The selection index of the run drawn on component line `y` of the last render, if that line holds one. */
	private runIndexAt(y: number): number | undefined {
		const bodyY = y - this.painted.y;
		if (bodyY < 0 || bodyY >= this.painted.height) return undefined;
		const run = this.lineRuns[this.painted.top + bodyY];
		if (!run) return undefined;
		const index = this.runs().indexOf(run);
		return index === -1 ? undefined : index;
	}

	/** Wrap the selection by `delta` runs. */
	private move(delta: number): void {
		const count = this.runs().length;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.follow = true;
		this.deps.requestRender();
	}

	/** Put the selection on run `index`, clamped to the ends without wrapping. */
	private moveTo(index: number): void {
		const count = this.runs().length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(Math.floor(index), count - 1));
		this.follow = true;
		this.deps.requestRender();
	}

	/** Runs the selection jumps on PgUp/PgDn: the entry lines the overlay has, at least one. */
	private pageSize(): number {
		return visibleRows(this.deps.rows(), 0);
	}

	/** Pan the rows by `delta` columns, never left of the start; the render clamps the far end to the widest row. */
	private panBy(delta: number): void {
		this.pan = Math.max(0, this.pan + delta);
		this.deps.requestRender();
	}

	/** Run `action` on the selected run, holding further keys until it settles and reporting a failure as a notice. */
	private act(action: RunAction): void {
		const run = this.selectedRun();
		if (!run) return;
		this.busy = action
			.call(this, run)
			.catch((err: unknown) => this.deps.dialogs.notify(err instanceof Error ? err.message : String(err), "error"))
			.finally(() => {
				this.busy = undefined;
				this.deps.requestRender();
			});
	}

	private async actions(run: Run): Promise<void> {
		const { showActions, suspend } = this.deps;
		if (!showActions) return;
		await suspend(() => showActions(run));
	}

	private async stop(run: Run): Promise<void> {
		const { dialogs, registry, suspend } = this.deps;
		if (!isLive(run)) return dialogs.notify(`${run.id} already ${run.state}`, "info");
		const confirmed = await suspend(() => dialogs.confirm("Stop subagent", `Stop ${run.agent} ${run.id}?`));
		if (confirmed) await registry.stop(run.id);
	}

	private async message(run: Run): Promise<void> {
		const { dialogs, registry, suspend, postNote } = this.deps;
		if (run.state !== "running") return dialogs.notify(`${run.id} is ${run.state}, so it cannot be steered`, "info");
		const text = (await suspend(() => dialogs.input(`Message to ${run.id}`)))?.trim();
		if (!text) return;
		await registry.send(run.id, text, "steer");
		postNote(`User steered ${run.id}: ${text}`);
	}

	private async answer(run: Run): Promise<void> {
		const { dialogs, registry, postNote } = this.deps;
		const questions = run.paused ?? [];
		if (run.state !== "paused" || questions.length === 0) return dialogs.notify(`${run.id} is not waiting for answers`, "info");
		const answers = await this.collectAnswers(questions);
		if (!answers) return;
		await registry.resume(run.id, { answers });
		postNote(`User answered ${run.id}'s questions`);
	}

	/** Open one input per question, offering its option labels as the placeholder. Return undefined when any input is cancelled. */
	private async collectAnswers(questions: AskQuestion[]): Promise<Record<string, string> | undefined> {
		const answers: Record<string, string> = {};
		for (const question of questions) {
			const options = (question.options ?? []).map((option) => option.label).join(" | ");
			const reply = await this.deps.suspend(() => this.deps.dialogs.input(question.question, options || undefined));
			if (reply === undefined) return undefined;
			answers[question.id] = reply;
		}
		return answers;
	}
}

/** Build the stop-all handler. It notifies when no run is running, else confirms by count and stops every running run. */
export function createStopAllHandler(
	getRegistry: () => Pick<ViewRegistry, "list" | "stopAll"> | undefined,
): (ctx: Pick<ExtensionContext, "ui">) => Promise<void> {
	return async (ctx) => {
		const registry = getRegistry();
		const count = registry?.list().filter(isLive).length ?? 0;
		if (!registry || count === 0) {
			ctx.ui.notify("No running subagents", "info");
			return;
		}
		const noun = count === 1 ? "subagent" : "subagents";
		if (!(await ctx.ui.confirm("Stop subagents", `Stop ${count} running ${noun}?`))) return;
		await registry.stopAll();
	};
}

/**
 * Open the focus-mode actions panel over `run`'s tool calls. The panel's log is built from the
 * run's message history and extended as the registry reports more messages, so a running run
 * streams. Resolves when the panel closes.
 */
async function openActionsPanel(ctx: ExtensionContext, registry: ViewRegistry, run: Run): Promise<void> {
	const log = new ActionLog();
	let seen = 0;
	const sync = () => {
		const current = registry.list().find((item) => item.id === run.id) ?? run;
		if (current.messages.length > seen) {
			log.addMessages(current.messages.slice(seen), isLive(current));
			seen = current.messages.length;
		}
	};
	sync();
	let panel: ActionsPanel | undefined;
	await openOverlay(ctx.ui, {
		options: { anchor: "center", width: PANEL_WIDTH, minWidth: PANEL_MIN_WIDTH },
		title: () => panel?.heading() ?? "",
		outsideClick: "close",
		refreshMs: ACTIONS_REFRESH_MS,
		build: (host, tui, theme) => {
			const unsubscribe = registry.on("change", (changed) => {
				if (changed.id !== run.id) return;
				sync();
				tui.requestRender();
			});
			const built = new ActionsPanel({
				entries: () => log.visible(),
				groups: () => log.groups(),
				label: (group) => log.label(group),
				title: `· ${run.agent} ${run.label}`,
				rows: () => tui.terminal.rows,
				requestRender: () => tui.requestRender(),
				theme,
				terminal: tui.terminal,
				done: () => host.close(),
			});
			panel = built;
			return {
				render: (width) => built.render(width),
				handleInput: (data) => built.handleInput(data),
				handleMouse: (event) => built.handleMouse(event),
				invalidate: () => built.invalidate(),
				dispose: () => {
					unsubscribe();
					built.dispose();
				},
			};
		},
	});
}

/** The open run list, kept so a second request closes it and a badge click does not stack another. */
const runListSlot = new OverlaySlot();

/**
 * Register the `/subagents` command, whose `stop` argument confirms and stops
 * every running run without the overlay, and the `alt+a` shortcut. The
 * shortcut and the bare command open the overlay, or close it when it is open.
 * Both resolve the registry at call time, since the registry is replaced with
 * each session. Outside the terminal UI they only notify.
 */
export function registerViewControls(pi: ExtensionAPI, getRegistry: () => ViewRegistry | undefined): void {
	const stopAll = createStopAllHandler(getRegistry);
	const stopAllInTui = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") return ctx.ui.notify("Stopping subagents needs the terminal UI", "warning");
		await stopAll(ctx);
	};

	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") return ctx.ui.notify("/subagents needs the terminal UI", "warning");
		if (runListSlot.active) return runListSlot.close();
		const registry = getRegistry();
		if (!registry) return ctx.ui.notify("No subagent session is active", "warning");
		await openRunList(pi, registry, ctx);
	};

	pi.registerCommand("subagents", {
		description: "List subagent runs, or stop them all with `stop`",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg !== "" && arg !== "stop") return ctx.ui.notify(`Unknown argument "${arg}". The only argument is "stop".`, "error");
			if (arg === "stop") return stopAllInTui(ctx);
			await toggle(ctx);
		},
	});

	pi.registerShortcut(TOGGLE_KEY, { description: "Open or close the subagents overlay", handler: toggle });
}

/**
 * Open the run list unless one is already open. Notices draw inside the
 * overlay, because a notification in the chat can sit behind it. Dialogs
 * opened from the overlay hide it first, because pi returns focus to the
 * editor when a dialog closes, and show it again after, which hands the
 * overlay its focus back. A press outside the overlay closes it.
 */
async function openRunList(pi: Pick<ExtensionAPI, "sendMessage">, registry: ViewRegistry, ctx: ExtensionContext): Promise<void> {
	let view: RunListView | undefined;
	let paint: Theme | undefined;
	const dialogs: ViewDialogs = {
		confirm: (title, message) => ctx.ui.confirm(title, message),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		notify: (message) => view?.showNotice(message),
	};
	await runListSlot.open(ctx.ui, {
		options: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "60%" },
		title: () => paint?.bold(OVERLAY_TITLE) ?? OVERLAY_TITLE,
		outsideClick: "close",
		refreshMs: REFRESH_MS,
		build: (host, tui, theme) => {
			paint = theme;
			const created = new RunListView({
				registry,
				dialogs,
				postNote: (content) => pi.sendMessage({ customType: NOTE_MESSAGE_TYPE, content, display: true }, { deliverAs: "nextTurn" }),
				close: () => host.close(),
				requestRender: () => host.requestRender(),
				suspend: (dialog) => host.suspend(dialog),
				showActions: (run) => openActionsPanel(ctx, registry, run),
				now: Date.now,
				rows: () => tui.terminal.rows,
				highlight: (text) => theme.fg("accent", text),
				paint: (state, text) => theme.fg(overlayStateColor(state), text),
				dim: (text) => theme.fg("dim", text),
				success: (text) => theme.fg("success", text),
				inverse: (text) => theme.inverse(text),
				terminal: tui.terminal,
			});
			view = created;
			return {
				render: (width) => created.render(width),
				handleInput: (data) => created.handleInput(data),
				handleMouse: (event) => created.handleMouse(event),
				invalidate: () => {},
				dispose: () => {
					view = undefined;
					created.dispose();
				},
			};
		},
	});
}
