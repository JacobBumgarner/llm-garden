/**
 * The aside overlay: a bordered box with a scrolling transcript, an input
 * line, and a status line showing the model and the hide key, or `copied` for
 * a moment after a copy. It talks to the side agent through a `PanelBackend`,
 * so tests run it with a fake.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type Component,
	type Focusable,
	Markdown,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../ask/extensions/clipboard.ts";
import type { PromptDisposition } from "../../shared/rpc.ts";
import { type Cell, highlightSelection, TextSelection } from "../../shared/selection.ts";

export { selectedText } from "../../shared/selection.ts";

export const TOGGLE_KEY = "alt+/";
export const WHEEL_LINES = 3;
/** Share of the terminal's rows the panel takes. The overlay clips lines past this, so the panel sizes its body to fit and keeps the editor on screen. */
const HEIGHT_RATIO = 0.7;
/** Share of the terminal's columns the panel takes: 4/9, a little under half so main stays readable beside it. */
const WIDTH_RATIO = 4 / 9;
export const OVERLAY_OPTIONS = {
	anchor: "top-right",
	width: `${(WIDTH_RATIO * 100).toFixed(2)}%` as `${number}%`,
	minWidth: 48,
	maxHeight: `${HEIGHT_RATIO * 100}%`,
	margin: { top: 1, right: 1 },
} as const;
/** How long the status line reads "copied" after a copy. */
const COPIED_MS = 1500;

/** Rows taken by the top rule, the status line, and the bottom rule. */
const FRAME_ROWS = 3;
const MIN_BODY_ROWS = 3;
/** Columns left of the transcript text: the border and one space. */
const FRAME_X = 2;
const TRANSCRIPT_OPEN = "<main-transcript>";
const TRANSCRIPT_CLOSE = "</main-transcript>";
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
}

export interface PanelOptions {
	tui: TUI;
	theme: Theme;
	backend: PanelBackend;
	/** Status line text: the model's short name. */
	model: string;
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

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, high));
}

/** Scroll offset clamped to the body, or pinned to the end. */
export function viewportTop(bodyHeight: number, viewportHeight: number, top: number, pinned: boolean): number {
	const max = Math.max(0, bodyHeight - viewportHeight);
	return pinned ? max : Math.min(Math.max(0, top), max);
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

/** Drop the transcript block the extension prepends to a question. */
function stripTranscript(text: string): string {
	if (!text.startsWith(TRANSCRIPT_OPEN)) return text;
	const end = text.indexOf(TRANSCRIPT_CLOSE);
	return end < 0 ? text : text.slice(end + TRANSCRIPT_CLOSE.length).replace(/^\s+/, "");
}

export class AsidePanel implements Component, Focusable {
	private readonly o: PanelOptions;
	private readonly editor: Editor;
	private readonly markdownTheme = getMarkdownTheme();
	private readonly unsubscribe: () => void;
	private items: Item[] = [];
	private current?: Extract<Item, { kind: "assistant" }>;
	private state: State = "starting";
	private startError?: string;
	private startPromise?: Promise<void>;
	private seeded = false;
	private streaming = false;
	private chain: Promise<void> = Promise.resolve();
	private top = 0;
	private pinned = true;
	private bodyRows = 10;
	private readonly selection = new TextSelection();
	private copiedUntil = 0;
	/** The transcript as last painted, unstyled, with the scroll offset and width, for mapping the pointer to text. */
	private painted: { lines: string[]; top: number; width: number } = { lines: [], top: 0, width: 0 };
	private _focused = false;

	constructor(options: PanelOptions) {
		this.o = options;
		const theme = options.theme;
		this.editor = new Editor(options.tui, {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		});
		this.unsubscribe = options.backend.subscribe({
			event: (ev) => this.onEvent(ev),
			exit: (reason) => this.onExit(reason),
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
		if (matchesKey(data, TOGGLE_KEY)) this.o.hide();
		else if (matchesKey(data, "escape")) this.escape();
		else if (matchesKey(data, "enter")) this.submit();
		else if (!this.scrollKey(data)) this.editor.handleInput(data);
		this.o.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollBy(Math.sign(event.wheelDelta ?? 0) * WHEEL_LINES);
			return { handled: true, render: true };
		}
		if (this.selection.dragging) {
			const { result, copy } = this.selection.drag(event, (x, y, edges) => this.cellAt(x, y, edges), this.painted.lines);
			if (copy !== undefined) this.copy(copy);
			return result;
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			const cell = this.cellAt(event.x, event.y, false);
			this.selection.press(cell);
			return { capture: cell !== undefined, handled: true, render: true };
		}
		if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
			const cell = this.cellAt(event.x, event.y, false);
			if (cell) this.copy(this.selection.selectLine(this.painted.lines, cell.line));
			return { handled: true, render: true };
		}
		return undefined;
	}

	/** Map a component-local point to the transcript cell under it; with `clampEdges` a point outside snaps to the nearest cell. */
	private cellAt(x: number, y: number, clampEdges: boolean): Cell | undefined {
		const { lines, top, width } = this.painted;
		if (lines.length === 0) return undefined;
		const bodyX = x - FRAME_X;
		const bodyY = y - 1;
		const inside = bodyX >= 0 && bodyX < width && bodyY >= 0 && bodyY < this.bodyRows && top + bodyY < lines.length;
		if (!clampEdges && !inside) return undefined;
		const line = clamp(top + clamp(bodyY, 0, this.bodyRows - 1), 0, lines.length - 1);
		return { line, col: clamp(bodyX, 0, width - 1) };
	}

	private now(): number {
		return (this.o.now ?? Date.now)();
	}

	private copy(text: string): void {
		if (text === "") return;
		void (this.o.copyToClipboard ?? copyToClipboard)(text, this.o.tui.terminal);
		this.copiedUntil = this.now() + COPIED_MS;
		setTimeout(() => this.o.tui.requestRender(), COPIED_MS).unref?.();
	}

	render(width: number): string[] {
		const theme = this.o.theme;
		const inner = Math.max(width - 4, 1);
		const editorLines = this.editor.render(inner);
		const total = Math.floor((this.o.tui.terminal.rows || 24) * HEIGHT_RATIO);
		this.bodyRows = Math.max(total - FRAME_ROWS - editorLines.length, MIN_BODY_ROWS);

		const lines = this.transcriptLines(inner);
		this.top = viewportTop(lines.length, this.bodyRows, this.top, this.pinned);
		this.pinned = this.top >= lines.length - this.bodyRows;
		this.painted = { lines: lines.map(stripTerminalSequences), top: this.top, width: inner };
		const body = lines
			.slice(this.top, this.top + this.bodyRows)
			.map((l, i) => highlightSelection(sliceByColumn(l, 0, inner), this.top + i, inner, this.selection.current, (s) => theme.inverse(s)));
		while (body.length < this.bodyRows) body.push("");

		const status =
			this.now() < this.copiedUntil
				? theme.fg("success", "copied")
				: theme.fg("dim", `${this.o.model} · esc hide`);
		return this.frame(width, [...body, ...editorLines, status]);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.unsubscribe();
	}

	/** Draw the rows inside a bordered box titled `aside`, each row cut to the inner width. */
	private frame(width: number, rows: string[]): string[] {
		const border = (s: string) => this.o.theme.fg("border", s);
		const inner = Math.max(width - 4, 1);
		const edge = Math.max(width - 2, 0);
		const title = truncateToWidth(" aside ", edge, "");
		const topRule = `┌${title}${"─".repeat(edge - visibleWidth(title))}┐`;
		const framed = rows.map((l) => `${border("│")} ${truncateToWidth(l, inner, "…", true)} ${border("│")}`);
		return [border(topRule), ...framed, border(`└${"─".repeat(edge)}┘`)];
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
		const empty = this.editor.getExpandedText().length === 0;
		if (matchesKey(data, "pageUp")) this.scrollBy(-this.bodyRows);
		else if (matchesKey(data, "pageDown")) this.scrollBy(this.bodyRows);
		else if (empty && matchesKey(data, "up")) this.scrollBy(-1);
		else if (empty && matchesKey(data, "down")) this.scrollBy(1);
		else if (empty && matchesKey(data, "home")) this.scrollBy(-this.top);
		else if (empty && matchesKey(data, "end")) this.pinned = true;
		else return false;
		return true;
	}

	private scrollBy(lines: number): void {
		this.top += lines;
		this.pinned = false;
	}

	private submit(): void {
		const text = this.editor.getExpandedText().trim();
		if (!text) return;
		this.editor.setText("");
		const item: Item = { kind: "user", text };
		this.items.push(item);
		this.pinned = true;
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

	private ensureReady(): Promise<void> {
		if (this.state === "ready") return Promise.resolve();
		this.startPromise ??= this.startBackend().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async startBackend(): Promise<void> {
		this.state = "starting";
		this.startError = undefined;
		this.o.tui.requestRender();
		try {
			await this.o.backend.start();
			if (!this.seeded) {
				this.seeded = true;
				this.items.unshift(...this.seedItems(await this.o.backend.getMessages()));
			}
			this.state = "ready";
		} catch (err) {
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
}
