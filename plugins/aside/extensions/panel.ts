/**
 * The aside panel: a scrolling transcript, an input
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
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CopyFeedback } from "../../shared/copy-feedback.ts";
import { editorTheme } from "../../shared/editor-theme.ts";
import type { PromptDisposition } from "../../shared/rpc.ts";
import { cellAt, highlightSelection, type PaintedText, TextSelection } from "../../shared/selection.ts";
import { Viewport } from "../../shared/viewport.ts";

export const TOGGLE_KEY = "alt+/";
/** Share of the terminal's rows the panel takes. The overlay clips lines past this, so the panel sizes its body to fit and keeps the editor on screen. */
const HEIGHT_RATIO = 0.7;
/** Share of the terminal's columns the panel takes: 5/9, a little over half, so the aside reads comfortably. */
const WIDTH_RATIO = 5 / 9;
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
	private readonly viewport = new Viewport();
	private bodyRows = 10;
	private readonly selection = new TextSelection();
	private readonly feedback: CopyFeedback;
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
		this.editor = new Editor(options.tui, editorTheme(options.theme));
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
			this.viewport.wheel(event.wheelDelta ?? 0);
			return { handled: true, render: true };
		}
		if (this.selection.dragging) {
			const { result, copy } = this.selection.drag(event, (x, y, edges) => cellAt(this.painted, x, y, edges), this.painted.lines);
			if (copy !== undefined) this.feedback.copy(copy);
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

		const lines = this.transcriptLines(inner);
		const top = this.viewport.layout(lines.length, this.bodyRows);
		this.painted = { lines: lines.map(stripTerminalSequences), x: 0, y: 0, width: inner, height: this.bodyRows, top, pan: 0 };
		const body = lines
			.slice(top, top + this.bodyRows)
			.map((l, i) => highlightSelection(sliceByColumn(l, 0, inner), top + i, inner, this.selection.current, (s) => theme.inverse(s)));
		while (body.length < this.bodyRows) body.push("");

		const status =
			this.feedback.active()
				? theme.fg("success", "copied")
				: theme.fg("dim", `${this.o.model} · esc hide`);
		return [...body, ...editorLines, status];
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.feedback.dispose();
		this.unsubscribe();
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

	private submit(): void {
		const text = this.editor.getExpandedText().trim();
		if (!text) return;
		this.editor.setText("");
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
