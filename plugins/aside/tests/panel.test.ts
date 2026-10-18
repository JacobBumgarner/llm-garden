import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { PromptDisposition } from "../../shared/rpc.ts";
import { type PanelBackend, type PanelEvent, type PanelListener, AsidePanel } from "../extensions/panel.ts";

const theme = {
	colors: {},
	style: (t: string) => t,
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	underline: (t: string) => t,
	inverse: (t: string) => t,
} as unknown as Theme;

class FakeBackend implements PanelBackend {
	sent: string[] = [];
	calls: string[] = [];
	messages: AgentMessage[] = [];
	disposition: PromptDisposition = "started";
	startError?: Error;
	release?: () => void;
	hold = false;
	listener?: PanelListener;
	starts = 0;

	async start() {
		this.starts++;
		if (this.hold) await new Promise<void>((r) => (this.release = r));
		if (this.startError) throw this.startError;
	}
	async send(text: string) {
		this.sent.push(text);
		return { disposition: this.disposition };
	}
	async abort() {
		this.calls.push("abort");
	}
	async getMessages() {
		return this.messages;
	}
	subscribe(l: PanelListener) {
		this.listener = l;
		return () => {
			this.listener = undefined;
			this.calls.push("unsubscribe");
		};
	}
	emit(ev: PanelEvent) {
		this.listener?.event(ev);
	}
}

function setup(backend = new FakeBackend(), rows = 30, panelTheme = theme, copy?: (t: string) => void, now?: () => number) {
	const log = { renders: 0, hide: 0 };
	const tui = { terminal: { rows, columns: 100, write() {} }, requestRender: () => void log.renders++ } as unknown as TUI;
	const panel = new AsidePanel({
		tui,
		theme: panelTheme,
		backend,
		model: "opus 5",
		hide: () => void log.hide++,
		copyToClipboard: copy,
		now,
	});
	return { panel, backend, log };
}

const tick = () => new Promise((r) => setImmediate(r));
const text = (panel: AsidePanel, width = 60) => panel.render(width).join("\n");

function answer(b: FakeBackend, content: string) {
	b.emit({ type: "agent_start" });
	b.emit({ type: "message_start", message: { role: "assistant", content: [] } });
	b.emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
	b.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: content } });
}

const wheel = (delta: number) => ({ type: "wheel", wheelDelta: delta }) as TuiMouseEvent;

describe("AsidePanel layout", () => {
	it("draws a status line under the editor and leaves the frame to the overlay", async () => {
		const { panel } = setup();
		await tick();
		const lines = panel.render(56);
		assert.match(lines.at(-1) ?? "", /opus 5 · esc hide/);
		assert.ok(!text(panel).includes("mcp"));
		assert.ok(lines.every((l) => !/[╭╮╰╯]/.test(l)));
	});
});

describe("startup gap", () => {
	it("shows the starting line, holds a question until start resolves, then sends", async () => {
		const b = new FakeBackend();
		b.hold = true;
		const { panel } = setup(b);
		assert.match(text(panel), /starting side agent\.\.\./);
		panel.handleInput("h");
		panel.handleInput("i");
		panel.handleInput("enter");
		await tick();
		assert.match(text(panel), /(^|\n)hi\s*\n\s+waiting for side agent/);
		assert.deepEqual(b.sent, []);
		b.release?.();
		await tick();
		await tick();
		assert.deepEqual(b.sent, ["hi"]);
		assert.doesNotMatch(text(panel), /waiting for side agent|starting side agent/);
	});

	it("shows a start failure in the body and retries on the next send", async () => {
		const b = new FakeBackend();
		b.startError = new Error("no pi");
		const { panel } = setup(b);
		await tick();
		assert.match(text(panel), /Side agent failed to start: no pi/);
		b.startError = undefined;
		panel.handleInput("q");
		panel.handleInput("enter");
		await tick();
		await tick();
		assert.equal(b.starts, 2);
		assert.deepEqual(b.sent, ["q"]);
		assert.doesNotMatch(text(panel), /failed to start/);
	});

	it("seeds the transcript from the child's messages and hides the transcript block", async () => {
		const b = new FakeBackend();
		b.messages = [
			{ role: "user", content: "<main-transcript>\n[User]: x\n</main-transcript>\n\nwhat is x?" },
			{ role: "assistant", content: [{ type: "text", text: "x is a thing" }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
			{ role: "toolResult", content: [{ type: "text", text: "hidden" }] },
		] as unknown as AgentMessage[];
		const { panel } = setup(b);
		await tick();
		const out = text(panel);
		assert.match(out, /(^|\n)\s*what is x\?/);
		assert.ok(!out.includes("> what is x"));
		assert.match(out, /x is a thing/);
		assert.match(out, /read a\.ts/);
		assert.doesNotMatch(out, /main-transcript|hidden/);
	});
});

describe("streaming", () => {
	it("appends deltas, shows tool calls as dim lines, and requests renders", async () => {
		const { panel, backend, log } = setup();
		await tick();
		const before = log.renders;
		answer(backend, "Hello");
		backend.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" } });
		backend.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolName: "grep" } });
		backend.emit({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { name: "grep", arguments: { pattern: "foo" } } },
		});
		assert.ok(log.renders > before);
		const out = text(panel);
		assert.match(out, /Hello world/);
		assert.match(out, /grep foo/);
	});

	it("keeps appending while the panel is not drawn", async () => {
		const { panel, backend } = setup();
		await tick();
		answer(backend, "one");
		backend.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " two" } });
		assert.match(text(panel), /one two/);
	});

	it("reports an error stop and a child exit", async () => {
		const { panel, backend } = setup();
		await tick();
		backend.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		backend.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limit" } });
		assert.match(text(panel), /Side agent error: rate limit/);
		backend.listener?.exit("Side agent exited (code 1).");
		assert.match(text(panel), /Side agent exited \(code 1\)/);
	});
});

describe("sending", () => {
	it("sends the editor text, clears the editor, and shows the question", async () => {
		const { panel, backend } = setup();
		await tick();
		for (const k of ["a", "b", "enter"]) panel.handleInput(k);
		await tick();
		assert.deepEqual(backend.sent, ["ab"]);
		assert.match(text(panel), /(^|\n)\s*ab/);
		panel.handleInput("enter");
		await tick();
		assert.deepEqual(backend.sent, ["ab"]);
	});

	it("renders the question with main's user message colors and no prefix", async () => {
		const tagged = { ...theme, fg: (c: string, t: string) => (c === "userMessageText" ? `<fg>${t}</fg>` : t), bg: (c: string, t: string) => (c === "userMessageBg" ? `<bg>${t}</bg>` : t) } as unknown as Theme;
		const { panel } = setup(new FakeBackend(), 30, tagged);
		await tick();
		for (const k of ["a", "b", "enter"]) panel.handleInput(k);
		await tick();
		assert.match(text(panel), /<bg><fg>ab<\/fg><\/bg>/);
		assert.ok(!text(panel).includes("> ab"));
	});

	it("keeps Shift+Enter as a newline in the editor", async () => {
		const { panel, backend } = setup();
		await tick();
		for (const k of ["a", "shift+enter", "b", "enter"]) panel.handleInput(k);
		await tick();
		assert.deepEqual(backend.sent, ["a\nb"]);
	});

	it("aborts an in-flight answer before sending a new question", async () => {
		const { panel, backend } = setup();
		await tick();
		answer(backend, "partial");
		panel.handleInput("q");
		panel.handleInput("enter");
		await tick();
		assert.deepEqual(backend.calls, ["abort"]);
		assert.deepEqual(backend.sent, ["q"]);
	});

	it("shows queued under a question the child queued", async () => {
		const b = new FakeBackend();
		b.disposition = "queued";
		const { panel } = setup(b);
		await tick();
		panel.handleInput("q");
		panel.handleInput("enter");
		await tick();
		assert.match(text(panel), /(^|\n)q\s*\n\s+queued/);
	});
});

describe("keys", () => {
	it("hides on alt+/", async () => {
		const { panel, log } = setup();
		await tick();
		panel.handleInput("alt+/");
		assert.equal(log.hide, 1);
	});

	it("aborts on Esc while streaming and hides on Esc while idle", async () => {
		const { panel, backend, log } = setup();
		await tick();
		answer(backend, "x");
		panel.handleInput("escape");
		assert.deepEqual(backend.calls, ["abort"]);
		assert.equal(log.hide, 0);
		backend.emit({ type: "agent_end" });
		panel.handleInput("escape");
		assert.equal(log.hide, 1);
	});

	it("unsubscribes from the backend on dispose", async () => {
		const { panel, backend } = setup();
		panel.dispose();
		assert.deepEqual(backend.calls, ["unsubscribe"]);
	});

	it("forwards other keys to the editor and focus to the editor", async () => {
		const { panel } = setup();
		await tick();
		panel.focused = true;
		panel.handleInput("z");
		assert.equal(panel.focused, true);
		assert.match(text(panel), /(^|\n)\s*z/);
	});
});

function longAnswer(b: FakeBackend, count: number) {
	answer(b, Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n\n"));
}

/** The number of the first `line N` visible in the transcript body. */
function firstLine(panel: AsidePanel): number {
	const m = /line (\d+)/.exec(text(panel));
	return m ? Number(m[1]) : Number.NaN;
}

describe("scrolling", () => {
	it("follows new output while pinned", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		const out = text(panel);
		assert.match(out, /line 60/);
		assert.doesNotMatch(out, /line 1\b/);
	});

	it("unpins on Up with an empty editor, and End pins again", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		text(panel);
		panel.handleInput("up");
		const afterUp = text(panel);
		assert.doesNotMatch(afterUp, /line 60\b/);
		backend.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "\n\nnewest" } });
		assert.doesNotMatch(text(panel), /newest/);
		panel.handleInput("end");
		assert.match(text(panel), /newest/);
	});

	it("sends Up to the editor when it holds text", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		text(panel);
		panel.handleInput("x");
		panel.handleInput("up");
		assert.match(text(panel), /line 60/);
	});

	it("Home goes to the top, PageDown moves a page, PageUp works with text in the editor", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		text(panel);
		panel.handleInput("home");
		assert.equal(firstLine(panel), 1);
		panel.handleInput("pageDown");
		assert.ok(firstLine(panel) > 1);
		panel.handleInput("x");
		panel.handleInput("pageUp");
		assert.equal(firstLine(panel), 1);
	});

	it("scrolls three lines per wheel notch and unpins", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		text(panel);
		const before = firstLine(panel);
		const result = panel.handleMouse(wheel(-1));
		assert.deepEqual(result, { handled: true, render: true });
		// Answer lines alternate with blanks, so three rows up moves the first visible line number by one or two.
		const after = firstLine(panel);
		assert.ok(after === before - 1 || after === before - 2, `${after} vs ${before}`);
		assert.deepEqual(panel.handleMouse({ type: "click" } as TuiMouseEvent), { handled: true });
	});

	it("pins again when a question is sent", async () => {
		const { panel, backend } = setup();
		await tick();
		longAnswer(backend, 60);
		text(panel);
		panel.handleMouse(wheel(-1));
		panel.handleMouse(wheel(-1));
		panel.handleInput("q");
		panel.handleInput("enter");
		await tick();
		assert.match(text(panel), /(^|\n)\s*q/);
	});

	describe("text selection", () => {
		const mouse = (type: string, x: number, y: number, extra: object = {}) =>
			({ type, button: "left", x, y, ...extra }) as unknown as TuiMouseEvent;

		async function withText() {
			const copies: string[] = [];
			const { panel, backend } = setup(new FakeBackend(), 30, theme, (t) => void copies.push(t));
			await tick();
			answer(backend, "hello world\n\nsecond line");
			panel.render(60);
			return { panel, copies };
		}

		it("copies the dragged span on release and keeps it highlighted", async () => {
			const { panel, copies } = await withText();
			panel.handleMouse(mouse("press", 0, 0));
			panel.handleMouse(mouse("drag", 4, 0));
			panel.handleMouse(mouse("release", 4, 0));
			assert.deepEqual(copies, ["hello"]);
			panel.handleInput("x");
			panel.render(60);
			assert.deepEqual(copies, ["hello"]);
		});

		it("spans lines when dragged down", async () => {
			const { panel, copies } = await withText();
			panel.handleMouse(mouse("press", 6, 0));
			panel.handleMouse(mouse("drag", 5, 2));
			panel.handleMouse(mouse("release", 5, 2));
			assert.deepEqual(copies, ["world\n\nsecond"]);
		});

		it("copies one line on a double click", async () => {
			const { panel, copies } = await withText();
			panel.handleMouse(mouse("click", 2, 2, { clickCount: 2 }));
			assert.deepEqual(copies, ["second line"]);
		});

		it("shows copied in the status line for a moment after a copy", async () => {
			let clock = 1000;
			const { panel, backend } = setup(new FakeBackend(), 30, theme, () => {}, () => clock);
			await tick();
			answer(backend, "hello world\n\nsecond line");
			assert.match(text(panel), /esc hide/);
			panel.handleMouse(mouse("click", 2, 2, { clickCount: 2 }));
			assert.doesNotMatch(text(panel), /esc hide/);
			assert.match(panel.render(56).at(-1) ?? "", /copied/);
			clock += 1499;
			assert.match(text(panel), /copied/);
			clock += 1;
			assert.match(text(panel), /esc hide/);
			assert.doesNotMatch(text(panel), /copied/);
		});

		it("copies nothing when released without movement", async () => {
			const { panel, copies } = await withText();
			panel.handleMouse(mouse("press", 1, 0));
			panel.handleMouse(mouse("release", 1, 0));
			assert.deepEqual(copies, []);
		});

		it("ignores a press outside the transcript body", async () => {
			const { panel } = await withText();
			assert.equal(panel.handleMouse(mouse("press", 1, -1))?.capture, false);
		});
	});
});
