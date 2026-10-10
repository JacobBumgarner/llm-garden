/**
 * Live view: the `subagent:live` event that publishes the running runs, the
 * `/subagents` overlay (drawn inside a box border) that lists every run of the
 * session, running runs above finished ones under headers that always draw,
 * scrolling the list to fit the height pi gives the overlay, with keys to
 * stop, steer, or answer the selected one, and the stop-all paths:
 * `/subagents stop`, the overlay `s` key, and a double Esc, which arrives as
 * the `subagent:stop-all` event. The `alt+a` shortcut and bare `/subagents`
 * toggle the overlay, the `subagent:open` event only opens it, and a click
 * that moves focus out of the box closes it. Dialogs and the overlay draw in
 * the terminal UI only, because RPC mode forwards every dialog to the parent.
 * The overlay component takes its dependencies as parameters, so its key
 * handling runs without a terminal.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AskQuestion } from "../../ask/extensions/types.ts";
import {
	formatOverlayRow,
	layoutOverlay,
	type OverlayEntry,
	type OverlayPaint,
	overlayStateColor,
	windowEntries,
} from "./format.ts";
import { isLive } from "./registry.ts";
import type { Run } from "./types.ts";

export const LIVE_EVENT = "subagent:live";
export const OPEN_EVENT = "subagent:open";
export const STOP_ALL_EVENT = "subagent:stop-all";
export const NOTE_MESSAGE_TYPE = "subagent-note";
export const REFRESH_MS = 5000;
export const TOGGLE_KEY = "alt+a";
const OVERLAY_TITLE = " subagents ";
const BOX_FRAME = 4;
const ROW_INDENT = 2;
const OVERLAY_HEIGHT_FRACTION = 0.6;
const BOX_EDGES = 2;
/** The leading blank, the blank above the help line, and the help line. */
const FIXED_LINES = 3;
const HELP_LINE = "↑↓ select · s stop · m message · a answer · esc or alt+a close";

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
	const unsubscribeOpen = pi.events.on(OPEN_EVENT, inTui((ctx) => openOverlay(pi, registry, ctx)));
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
export function entryCapacity(rows: number, noticeLines: number): number {
	return Math.floor(rows * OVERLAY_HEIGHT_FRACTION) - BOX_EDGES - FIXED_LINES - noticeLines;
}

/** Return the columns left for content inside a box of `width`: the frame takes two columns a side. */
export function boxInnerWidth(width: number): number {
	return Math.max(width - BOX_FRAME, 1);
}

/**
 * Draw `inner` lines inside a box whose top edge carries `title`. Each line
 * truncates to the inner width and pads to it. `border` paints the frame.
 */
export function boxLines(inner: string[], width: number, title: string, border: (text: string) => string): string[] {
	const edge = Math.max(width - 2, 0);
	const titleText = truncateToWidth(title, edge, "");
	const top = `┌${titleText}${"─".repeat(edge - visibleWidth(titleText))}┐`;
	const bottom = `└${"─".repeat(edge)}┘`;
	const rows = inner.map((line) => `${border("│")} ${truncateToWidth(line, boxInnerWidth(width), "…", true)} ${border("│")}`);
	return [border(top), ...rows, border(bottom)];
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
	now: () => number;
	/** The terminal height in rows, which the overlay's height cap is a fraction of. */
	rows: () => number;
	/** Style the selected row. */
	highlight: (text: string) => string;
	/** Color the icon and state word of an unselected row by the run state. */
	paint: OverlayPaint;
	/** Style the key line, headers, and empty-group lines. */
	dim: (text: string) => string;
}

type RunAction = (run: Run) => Promise<void>;

/**
 * Overlay component listing the running runs, then the finished runs, each
 * newest first, with a dim header titling each group and a dim `(none)` line
 * under an empty one. Unselected rows paint the icon and state word by state,
 * and the selected row takes the highlight alone. The arrow keys move a
 * selection over runs and skip headers, gaps, and `(none)` lines. Keys act on
 * the selected run: `s` stops it after a confirm, `m` steers it, `a` answers a
 * paused run, esc closes. Runs that do not fit the overlay's height scroll
 * with the selection, and dim `↑ N more` and `↓ N more` lines count the
 * entries hidden on each side.
 */
export class RunListView {
	private selected = 0;
	private windowStart = 0;
	private notice: string | undefined;
	private busy: Promise<void> | undefined;
	private readonly deps: RunListDeps;
	private readonly unsubscribe: () => void;

	constructor(deps: RunListDeps) {
		this.deps = deps;
		this.unsubscribe = deps.registry.on("change", () => {
			this.clamp();
			deps.requestRender();
		});
	}

	/** Stop listening to the registry. */
	dispose(): void {
		this.unsubscribe();
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
		const selectedIndex = entries.findIndex((entry) => entry.kind === "run" && entry.run === selected);
		const view = windowEntries(entries, selectedIndex, entryCapacity(this.deps.rows(), notice.length), this.windowStart);
		this.windowStart = view.start;
		const rows = view.entries.map((entry) => {
			if (entry.kind === "gap") return "";
			if (entry.kind === "header") return this.dimLine(entry.title);
			if (entry.kind === "none") return this.dimLine("(none)");
			return `${pad}${this.row(entry.run, entry.run === selected, width - ROW_INDENT)}`;
		});
		if (view.above > 0) rows.unshift(this.dimLine(`↑ ${view.above} more`));
		if (view.below > 0) rows.push(this.dimLine(`↓ ${view.below} more`));
		return ["", ...rows, ...notice, "", this.deps.dim(HELP_LINE)];
	}

	private row(run: Run, selected: boolean, width: number): string {
		const fit = Math.max(width - 2, 1);
		// unpainted: theme.fg resets the foreground at its end, which would cut the highlight short
		if (selected) return this.deps.highlight(`> ${formatOverlayRow(run, this.deps.now(), fit)}`);
		return `  ${formatOverlayRow(run, this.deps.now(), fit, this.deps.paint)}`;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		this.notice = undefined;
		// The focused overlay owns input, so pi's shortcut router never sees the toggle chord while it is open.
		if (matchesKey(data, "escape") || matchesKey(data, TOGGLE_KEY)) return this.deps.close();
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "s")) return this.act(this.stop);
		if (matchesKey(data, "m")) return this.act(this.message);
		if (matchesKey(data, "a")) return this.act(this.answer);
	}

	private move(delta: number): void {
		const count = this.runs().length;
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
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

/** The open overlay, kept so a second request closes it and a badge click does not stack another. */
let activeOverlay: { close: () => void } | undefined;

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
		if (activeOverlay) return activeOverlay.close();
		const registry = getRegistry();
		if (!registry) return ctx.ui.notify("No subagent session is active", "warning");
		await openOverlay(pi, registry, ctx);
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
 * Track whether an overlay has lost focus to another component, such as the
 * editor under a click outside the box. Focus counts as lost only after the
 * overlay has been seen focused once, and never while it is hidden behind a
 * dialog it opened.
 */
export function createBlurWatch(): { lost: (handle: Pick<OverlayHandle, "isFocused" | "isHidden">) => boolean } {
	let sawFocus = false;
	return {
		lost(handle) {
			if (handle.isHidden()) return false;
			if (handle.isFocused()) {
				sawFocus = true;
				return false;
			}
			return sawFocus;
		},
	};
}

/**
 * Open the run list unless one is already open. Notices draw inside the
 * overlay, because a notification in the chat can sit behind it. Dialogs
 * opened from the overlay hide it first, because pi returns focus to the
 * editor when a dialog closes, and show it again after, which hands the
 * overlay its focus back. A render that finds focus moved elsewhere closes
 * the overlay, since pi sends no outside-click event to it.
 */
async function openOverlay(pi: Pick<ExtensionAPI, "sendMessage">, registry: ViewRegistry, ctx: ExtensionContext): Promise<void> {
	if (activeOverlay) return;
	let handle: OverlayHandle | undefined;
	let view: RunListView | undefined;
	let finish: (() => void) | undefined;
	const self = { close: () => finish?.() };
	activeOverlay = self;
	const dialogs: ViewDialogs = {
		confirm: (title, message) => ctx.ui.confirm(title, message),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		notify: (message) => view?.showNotice(message),
	};
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const created = new RunListView({
					registry,
					dialogs,
					postNote: (content) =>
						pi.sendMessage({ customType: NOTE_MESSAGE_TYPE, content, display: true }, { deliverAs: "nextTurn" }),
					close: () => done(),
					requestRender: () => tui.requestRender(),
					suspend: async (dialog) => {
						handle?.setHidden(true);
						try {
							return await dialog();
						} finally {
							handle?.setHidden(false);
							handle?.focus();
						}
					},
					now: Date.now,
					rows: () => tui.terminal.rows,
					highlight: (text) => theme.fg("accent", text),
					paint: (state, text) => theme.fg(overlayStateColor(state), text),
					dim: (text) => theme.fg("dim", text),
				});
				view = created;
				finish = () => done();
				const refresh = setInterval(() => tui.requestRender(), REFRESH_MS);
				refresh.unref?.();
				const blur = createBlurWatch();
				return {
					render: (width) => {
						if (handle && blur.lost(handle)) queueMicrotask(() => done());
						return boxLines(created.render(boxInnerWidth(width)), width, OVERLAY_TITLE, (text) => theme.fg("border", text));
					},
					handleInput: (data) => created.handleInput(data),
					invalidate: () => {},
					dispose: () => {
						clearInterval(refresh);
						view = undefined;
						created.dispose();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "60%" },
				onHandle: (value) => {
					handle = value;
				},
			},
		);
	} finally {
		if (activeOverlay === self) activeOverlay = undefined;
	}
}
