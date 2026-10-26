/**
 * The aside panel: a scrolling transcript, an input
 * line, and a status line showing the model and the hide key, or `copied` for
 * a moment after a copy. It talks to the side agent through a `PanelBackend`,
 * so tests run it with a fake.
 *
 * The input line takes three commands besides questions, offered by autocomplete
 * after a `/`: `/new` starts a fresh aside session, `/resume` opens a picker over
 * this main session's earlier asides, and `/model` opens a picker over the side agent's models.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Editor,
	type Component,
	type Focusable,
	Markdown,
	matchesKey,
	SelectList,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CopyFeedback } from "../../shared/copy-feedback.ts";
import { editorTheme } from "../../shared/editor-theme.ts";
import type { PromptDisposition } from "../../shared/rpc.ts";
import { cellAt, DragAutoScroll, highlightSelection, type PaintedText, TextSelection } from "../../shared/selection.ts";
import { Viewport } from "../../shared/viewport.ts";
import { stripTranscript } from "./feed.ts";

export const TOGGLE_KEY = "alt+/";
/** Share of the terminal's rows the panel takes. The overlay clips lines past this, so the panel sizes its body to fit and keeps the editor on screen. */
const HEIGHT_RATIO = 0.85;
/** Share of the terminal's columns the panel takes: 60%, a little over half, so the aside reads comfortably. */
const WIDTH_RATIO = 0.6;
export const OVERLAY_OPTIONS = {
	anchor: "top-right",
	width: `${(WIDTH_RATIO * 100).toFixed(2)}%` as `${number}%`,
	minWidth: 48,
	maxHeight: `${HEIGHT_RATIO * 100}%`,
	margin: { top: 1, right: 1 },
} as const;

/** Rows taken by the frame's top and bottom edges and the status line. */
const FRAME_ROWS = 3;
const MIN_BODY_ROWS = 3;
/** The slash commands the input line takes, as the autocomplete offers them. */
export const COMMANDS = [
	{ name: "new", description: "Start a fresh aside session" },
	{ name: "resume", description: "Reopen an earlier aside of this session" },
	{ name: "model", description: "Switch the side agent's model", argumentHint: "[filter]" },
];
const COMMANDS_HINT = `Commands: ${COMMANDS.map((c) => `/${c.name}`).join(", ")}`;
const PRIMARY_ARGS = ["path", "pattern", "query", "command", "url"];

/** A stream event from the side agent. The panel reads only the fields below. */
export interface PanelEvent {
	type: string;
	message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
	assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string; content?: string; toolName?: string; toolCall?: { name?: string; arguments?: unknown } };
}

export interface PanelListener {
	event(event: PanelEvent): void;
	exit(reason: string): void;
	/** The aside moved to another session, new or resumed. The panel drops its transcript and starts over. */
	switched(): void;
}

/** One aside session of this main session, as the resume picker lists it. */
export interface SessionChoice {
	id: string;
	/** Short name, such as `aside 2`. */
	title: string;
	/** When it was last written and how it opened. */
	detail: string;
	current: boolean;
}

/** One model the side agent can switch to. */
export interface ModelChoice {
	/** Key for `setModel`, as `provider/id`. */
	id: string;
	/** Short name, as the status line shows it. */
	title: string;
	detail: string;
	current: boolean;
}

/** What the panel needs from the side agent. */
export interface PanelBackend {
	/** Start the side agent when it is not running. Resolves when it answers. */
	start(): Promise<void>;
	/** Send a question with any main transcript delta. */
	send(text: string): Promise<{ disposition: PromptDisposition }>;
	abort(): Promise<void>;
	getMessages(): Promise<AgentMessage[]>;
	/** Receive events from every side agent process of this aside. Returns the unsubscribe function. */
	subscribe(listener: PanelListener): () => void;
	/** Stop the side agent and move to a fresh aside session. Listeners hear `switched`. */
	startNew(): Promise<void>;
	/** Stop the side agent and move to an earlier aside session. Listeners hear `switched`. */
	resume(id: string): Promise<void>;
	/** This main session's aside sessions on disk, newest first. */
	listSessions(): Promise<SessionChoice[]>;
	/** The models the running side agent can switch to. */
	listModels(): Promise<ModelChoice[]>;
	/** Switch the running side agent's model. Resolves to the status line's name for it. */
	setModel(id: string): Promise<string>;
}

export interface PanelOptions {
	tui: TUI;
	theme: Theme;
	backend: PanelBackend;
	/** Status line text: the model's short name, until `/model` changes it. */
	model: string;
	/** Base for `@path` completions in the input line. Omitted means no autocomplete. */
	cwd?: string;
	/** Hide the panel and hand focus back to main. */
	hide: () => void;
	/** Copy selected text to the clipboard. Defaults to `copyToClipboard`. */
	copyToClipboard?: (text: string, terminal: { write(data: string): void }) => unknown;
	/** Clock in milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

type Part = { type: "text"; text: string } | { type: "tool"; line: string };

/** Assistant parts are indexed by the stream's `contentIndex`, so thinking blocks leave holes. */
type Item =
	| { kind: "user"; text: string; status?: string }
	| { kind: "assistant"; parts: (Part | undefined)[] }
	| { kind: "note"; text: string; dim?: boolean };

type State = "starting" | "ready" | "failed" | "stopped";

/** What a picker needs of a session or model: an id to act on, a title, a detail column, and whether it is the one in use. */
interface Choice {
	id: string;
	title: string;
	detail: string;
	current: boolean;
}

interface Picker {
	title: string;
	/** The status line's word for Enter. */
	verb: string;
	list: SelectList;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => !!p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

/** Describe a tool call as one line: its name and its main argument. */
export function toolLine(name: string, args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const key = PRIMARY_ARGS.find((k) => typeof record[k] === "string") ?? Object.keys(record).find((k) => typeof record[k] === "string");
	return key ? `${name} ${String(record[key])}` : name;
}

function partsOf(content: unknown): Part[] {
	if (!Array.isArray(content)) return [];
	const parts: Part[] = [];
	for (const p of content) {
		if (!p || typeof p !== "object") continue;
		if (p.type === "text" && typeof p.text === "string" && p.text) parts.push({ type: "text", text: p.text });
		else if (p.type === "toolCall") parts.push({ type: "tool", line: toolLine(String(p.name), p.arguments) });
	}
	return parts;
}

export class AsidePanel implements Component, Focusable {
	private readonly o: PanelOptions;
	private readonly editor: Editor;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly unsubscribe: () => void;
	private items: Item[] = [];
	private current?: Extract<Item, { kind: "assistant" }>;
	private state: State = "starting";
	private model: string;
	private startError?: string;
	private startPromise?: Promise<void>;
	/** Bumped on each session switch, so a start begun for the old session cannot write its outcome into the new one. */
	private generation = 0;
	private seeded = false;
	private streaming = false;
	private chain: Promise<void> = Promise.resolve();
	/** The open picker, if any. It replaces the transcript and takes the keys. */
	private picker?: Picker;
	private readonly viewport = new Viewport();
	private bodyRows = 10;
	private readonly selection = new TextSelection();
	private readonly feedback: CopyFeedback;
	private readonly autoScroll = new DragAutoScroll({
		scrollBy: (lines) => this.viewport.scrollBy(lines),
		onTick: () => this.autoScrollTick(),
	});
	/** The transcript as last painted, unstyled, for mapping the pointer to text. */
	private painted: PaintedText = { lines: [], x: 0, y: 0, width: 0, height: 0, top: 0, pan: 0 };
	private _focused = false;

	constructor(options: PanelOptions) {
		this.o = options;
		const send = options.copyToClipboard;
		this.feedback = new CopyFeedback({
			requestRender: () => options.tui.requestRender(),
			terminal: options.tui.terminal,
			copy: send ? (text) => void send(text, options.tui.terminal) : undefined,
			now: options.now,
		});
		this.model = options.model;
		this.editor = new Editor(options.tui, editorTheme(options.theme));
		this.editor.onSubmit = (value) => this.submit(value);
		if (options.cwd !== undefined) this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, options.cwd));
		this.unsubscribe = options.backend.subscribe({
			event: (ev) => this.onEvent(ev),
			exit: (reason) => this.onExit(reason),
			switched: () => this.onSwitched(),
		});
		void this.ensureReady().catch(() => {});
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	handleInput(data: string): void {
		this.selection.clear();
		this.autoScroll.stop();
		if (matchesKey(data, TOGGLE_KEY)) this.o.hide();
		else if (this.picker) this.picker.list.handleInput(data);
		else if (this.editor.isShowingAutocomplete()) this.editor.handleInput(data);
		else if (matchesKey(data, "escape")) this.escape();
		else if (!this.scrollKey(data)) this.editor.handleInput(data);
		this.o.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.viewport.wheel(event.wheelDelta ?? 0);
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
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			const cell = cellAt(this.painted, event.x, event.y, false);
			this.selection.press(cell);
			return { capture: cell !== undefined, handled: true, render: true };
		}
		if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
			const cell = cellAt(this.painted, event.x, event.y, false);
			if (cell) this.feedback.copy(this.selection.selectClicks(this.painted.lines, cell, event.clickCount ?? 2));
			return { handled: true, render: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const theme = this.o.theme;
		const inner = Math.max(width, 1);
		const editorLines = this.editor.render(inner);
		const total = Math.floor((this.o.tui.terminal.rows || 24) * HEIGHT_RATIO);
		this.bodyRows = Math.max(total - FRAME_ROWS - editorLines.length, MIN_BODY_ROWS);

		const body = this.picker ? this.pickerLines(inner) : this.bodyLines(inner);
		while (body.length < this.bodyRows) body.push("");

		const status = this.feedback.active()
			? theme.fg("success", "copied")
			: theme.fg("dim", this.picker ? `↑↓ pick · enter ${this.picker.verb} · esc cancel` : `${this.model} · esc hide`);
		return [...body, ...editorLines, status];
	}

	private bodyLines(inner: number): string[] {
		const theme = this.o.theme;
		const lines = this.transcriptLines(inner);
		const top = this.viewport.layout(lines.length, this.bodyRows);
		this.painted = { lines: lines.map(stripTerminalSequences), x: 0, y: 0, width: inner, height: this.bodyRows, top, pan: 0 };
		return lines
			.slice(top, top + this.bodyRows)
			.map((l, i) => highlightSelection(sliceByColumn(l, 0, inner), top + i, inner, this.selection.current, (s) => theme.inverse(s)));
	}

	/** The resume picker under a heading. Nothing here is selectable text, so the painted map is emptied. */
	private pickerLines(inner: number): string[] {
		this.painted = { lines: [], x: 0, y: 0, width: inner, height: this.bodyRows, top: 0, pan: 0 };
		const lines = [this.o.theme.fg("accent", this.o.theme.bold(this.picker?.title ?? "")), "", ...(this.picker?.list.render(inner) ?? [])];
		return lines.slice(0, this.bodyRows);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.autoScroll.dispose();
		this.feedback.dispose();
		this.unsubscribe();
	}

	/** Re-lay out after an auto-scroll step and pull the selection's focus to the cell under the held pointer. */
	private autoScrollTick(): void {
		const pointer = this.autoScroll.pointer;
		this.painted.top = this.viewport.layout(this.painted.lines.length, this.painted.height);
		if (pointer) this.selection.extend(cellAt(this.painted, pointer.x, pointer.y, true));
		this.o.tui.requestRender();
	}

	private transcriptLines(width: number): string[] {
		const theme = this.o.theme;
		const out: string[] = [];
		const gap = () => {
			if (out.length > 0) out.push("");
		};
		for (const item of this.items) {
			gap();
			if (item.kind === "user") {
				const style = { color: (s: string) => theme.fg("userMessageText", s), bgColor: (s: string) => theme.bg("userMessageBg", s) };
				const options = { preserveOrderedListMarkers: true, preserveBackslashEscapes: true };
				out.push(...new Markdown(item.text, 1, 1, this.markdownTheme, style, options).render(width));
				if (item.status) out.push(theme.fg("dim", `  ${item.status}`));
			} else if (item.kind === "note") {
				for (const l of wrapTextWithAnsi(item.text, width)) out.push(theme.fg(item.dim ? "dim" : "warning", l));
			} else {
				for (const part of item.parts) {
					if (!part) continue;
					if (part.type === "text") out.push(...new Markdown(part.text, 0, 0, this.markdownTheme).render(width));
					else out.push(theme.fg("dim", truncateToWidth(part.line, width, "…")));
				}
			}
		}
		if (this.state === "starting") {
			gap();
			out.push(theme.fg("dim", "starting side agent..."));
		} else if (this.startError) {
			gap();
			for (const l of wrapTextWithAnsi(this.startError, width)) out.push(theme.fg("error", l));
		}
		return out;
	}

	/** Abort a streaming answer, or hide the panel when idle. */
	private escape(): void {
		if (this.streaming) void this.o.backend.abort().catch(() => {});
		else this.o.hide();
	}

	/** Scroll for a navigation key. Returns false when the key is not one, so it reaches the editor. Up, Down, Home, and End scroll only while the editor is empty, so they still move the cursor in a typed question. */
	private scrollKey(data: string): boolean {
		const page = matchesKey(data, "pageUp") || matchesKey(data, "pageDown");
		if (!page && this.editor.getExpandedText().length > 0) return false;
		return this.viewport.handleKey(data, this.bodyRows);
	}

	/** Handle the editor's submit. The editor has already cleared itself and hands over what it held. */
	private submit(value: string): void {
		const text = value.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			this.chain = this.chain.then(() => this.command(text));
			return;
		}
		const item: Item = { kind: "user", text };
		this.items.push(item);
		this.viewport.toEnd();
		this.chain = this.chain.then(() => this.deliver(item, text));
	}

	private async deliver(item: Extract<Item, { kind: "user" }>, text: string): Promise<void> {
		try {
			if (this.state !== "ready") {
				item.status = "waiting for side agent";
				this.o.tui.requestRender();
				await this.ensureReady();
			}
			if (this.streaming) await this.o.backend.abort();
			const sent = await this.o.backend.send(text);
			item.status = sent.disposition === "queued" ? "queued" : undefined;
		} catch (err) {
			item.status = undefined;
			this.items.push({ kind: "note", text: `Could not send: ${err instanceof Error ? err.message : String(err)}` });
		}
		this.o.tui.requestRender();
	}

	/** Run a slash command typed in the input line. */
	private async command(text: string): Promise<void> {
		const [name, ...rest] = text.slice(1).split(/\s+/);
		try {
			if (name === "new" && rest.length === 0) await this.o.backend.startNew();
			else if (name === "resume" && rest.length === 0) await this.pickSession();
			else if (name === "model") await this.pickModel(rest.join(" "));
			else this.note(`Unknown command ${text}. ${COMMANDS_HINT}`);
		} catch (err) {
			this.note(`Could not run ${text}: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.o.tui.requestRender();
	}

	private note(text: string, dim = false): void {
		this.items.push({ kind: "note", text, dim });
		this.viewport.toEnd();
	}

	/** List this main session's asides and let the user pick one. Picking the current one or cancelling leaves the transcript as it is. */
	private async pickSession(): Promise<void> {
		const sessions = await this.o.backend.listSessions();
		if (sessions.length === 0) {
			this.note("No saved asides for this session yet.", true);
			return;
		}
		this.pick("resume an aside", "resume", sessions, (chosen) =>
			this.o.backend.resume(chosen.id).catch((err) => this.note(`Could not resume ${chosen.title}: ${message(err)}`)),
		);
	}

	/** List the side agent's models and switch to the one picked. The side agent has to be running to answer, so a start happens first. */
	private async pickModel(filter: string): Promise<void> {
		await this.ensureReady();
		const models = await this.o.backend.listModels();
		if (models.length === 0) {
			this.note("The side agent lists no models.", true);
			return;
		}
		this.pick(
			"switch model",
			"select",
			models,
			(chosen) =>
				this.o.backend
					.setModel(chosen.id)
					.then((label) => {
						this.model = label;
						this.note(`Model switched to ${label}.`, true);
					})
					.catch((err) => this.note(`Could not switch to ${chosen.title}: ${message(err)}`)),
			filter,
		);
	}

	/** Open a picker over `choices`. The current one is marked, and picking it or cancelling changes nothing. The chosen action runs on the chain. */
	private pick<T extends Choice>(title: string, verb: string, choices: T[], act: (chosen: T) => Promise<void>, filter = ""): void {
		const items = choices.map((c) => ({ value: c.id, label: c.current ? `${c.title} (current)` : c.title, description: c.detail }));
		const list = new SelectList(items, Math.max(1, this.bodyRows - 2), getSelectListTheme(), { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 36 });
		if (filter) list.setFilter(filter);
		const picker: Picker = { title, verb, list };
		const close = () => {
			if (this.picker === picker) this.picker = undefined;
			this.o.tui.requestRender();
		};
		list.onCancel = close;
		list.onSelect = (item) => {
			close();
			const chosen = choices.find((c) => c.id === item.value);
			if (!chosen || chosen.current) return;
			this.chain = this.chain.then(() => act(chosen)).then(() => this.o.tui.requestRender());
		};
		this.picker = picker;
	}

	private ensureReady(): Promise<void> {
		if (this.state === "ready") return Promise.resolve();
		if (!this.startPromise) {
			const started: Promise<void> = this.startBackend().finally(() => {
				if (this.startPromise === started) this.startPromise = undefined;
			});
			this.startPromise = started;
		}
		return this.startPromise;
	}

	private async startBackend(): Promise<void> {
		const generation = this.generation;
		this.state = "starting";
		this.startError = undefined;
		this.o.tui.requestRender();
		try {
			await this.o.backend.start();
			const messages = this.seeded ? [] : await this.o.backend.getMessages();
			if (generation !== this.generation) return;
			if (!this.seeded) {
				this.seeded = true;
				this.items.unshift(...this.seedItems(messages));
			}
			this.state = "ready";
		} catch (err) {
			if (generation !== this.generation) return;
			this.state = "failed";
			this.startError = `Side agent failed to start: ${err instanceof Error ? err.message : String(err)}`;
			throw err;
		} finally {
			this.o.tui.requestRender();
		}
	}

	private seedItems(messages: AgentMessage[]): Item[] {
		const items: Item[] = [];
		for (const m of messages) {
			const msg = m as { role?: string; content?: unknown };
			if (msg.role === "user") {
				const text = stripTranscript(textOf(msg.content));
				if (text) items.push({ kind: "user", text });
			} else if (msg.role === "assistant") {
				const parts = partsOf(msg.content);
				if (parts.length > 0) items.push({ kind: "assistant", parts });
			}
		}
		return items;
	}

	private assistant(): Extract<Item, { kind: "assistant" }> {
		if (!this.current) {
			this.current = { kind: "assistant", parts: [] };
			this.items.push(this.current);
		}
		return this.current;
	}

	private onEvent(ev: PanelEvent): void {
		if (ev.type === "agent_start") this.streaming = true;
		else if (ev.type === "agent_end") this.streaming = false;
		else if (ev.type === "message_start" && ev.message?.role === "assistant") {
			this.current = undefined;
			this.assistant().parts = partsOf(ev.message.content);
		} else if (ev.type === "message_update" && ev.assistantMessageEvent) this.onUpdate(ev.assistantMessageEvent);
		else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const item = this.assistant();
			item.parts = partsOf(ev.message.content);
			if (ev.message.stopReason === "error" && ev.message.errorMessage) {
				this.items.push({ kind: "note", text: `Side agent error: ${ev.message.errorMessage}` });
			}
			this.current = undefined;
		}
		this.o.tui.requestRender();
	}

	private onUpdate(update: NonNullable<PanelEvent["assistantMessageEvent"]>): void {
		const index = update.contentIndex ?? 0;
		const item = this.assistant();
		const part = item.parts[index];
		if (update.type === "text_start") item.parts[index] = { type: "text", text: "" };
		else if (update.type === "text_delta") {
			if (part?.type === "text") part.text += update.delta ?? "";
			else item.parts[index] = { type: "text", text: update.delta ?? "" };
		} else if (update.type === "text_end" && update.content !== undefined) item.parts[index] = { type: "text", text: update.content };
		else if (update.type === "toolcall_start") item.parts[index] = { type: "tool", line: update.toolName ?? "tool" };
		else if (update.type === "toolcall_end" && update.toolCall) {
			item.parts[index] = { type: "tool", line: toolLine(String(update.toolCall.name), update.toolCall.arguments) };
		}
	}

	private onExit(reason: string): void {
		this.streaming = false;
		this.current = undefined;
		this.state = "stopped";
		this.items.push({ kind: "note", text: reason });
		this.o.tui.requestRender();
	}

	/** Forget the old session's transcript and start the side agent on the new one. */
	private onSwitched(): void {
		this.generation++;
		this.startPromise = undefined;
		this.items = [];
		this.current = undefined;
		this.picker = undefined;
		this.seeded = false;
		this.streaming = false;
		this.startError = undefined;
		this.state = "starting";
		this.selection.clear();
		this.viewport.toEnd();
		void this.ensureReady().catch(() => {});
		this.o.tui.requestRender();
	}
}
