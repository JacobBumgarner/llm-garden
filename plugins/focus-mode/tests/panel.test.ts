import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActionEntry } from "../extensions/log.ts";
import { ActionsPanel, bodyLayout, bodyLines, entryLines, groupHeader, type PanelStyle, panelRows, selectedText, viewportTop } from "../extensions/panel.ts";

/** Plain styling so assertions can read the text. */
const style: PanelStyle = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => `[${text}]`,
};

function entry(overrides: Partial<ActionEntry> & Pick<ActionEntry, "id" | "name">): ActionEntry {
	return { group: 1, step: 1, args: {}, tail: [], ...overrides };
}

describe("entryLines", () => {
	it("draws a running call with a hollow glyph and its elapsed time", () => {
		const lines = entryLines(entry({ id: "a", name: "bash", args: { command: "ls" }, startedAt: 0 }), style, 3000);
		assert.deepEqual(lines, ["○ … $ ls · 3s"]);
	});

	it("draws a finished call with the recorded duration and the tail", () => {
		const done = entry({
			id: "a",
			name: "read",
			args: { path: "f.ts" },
			result: { text: "", details: undefined, isError: false },
			durationMs: 2000,
			tail: ["x", "y"],
		});
		assert.deepEqual(entryLines(done, style), ["● read f.ts · 2s", "  │ x", "  │ y"]);
	});

	it("draws long summaries at full length with the error marker after them", () => {
		const failed = entry({
			id: "a",
			name: "bash",
			args: { command: "a-very-long-command-that-does-not-fit" },
			result: { text: "", details: undefined, isError: true },
		});
		assert.deepEqual(entryLines(failed, style), ["● $ a-very-long-command-that-does-not-fit error"]);
	});

	it("indents nested calls", () => {
		const nested = entry({ id: "a/1", name: "read", args: { path: "f" }, parentId: "a" });
		assert.deepEqual(entryLines(nested, style), ["  ○ … read f"]);
	});
});

describe("groupHeader", () => {
	it("pads the label to the given width in the user message colors", () => {
		const styled: PanelStyle = { ...style, bg: (color, text) => `<${color}>${text}</>`, fg: (color, text) => `{${color}:${text}}` };
		assert.equal(groupHeader("fix tests", 20, styled), "<userMessageBg> {userMessageText:fix tests}          </>");
		assert.equal(groupHeader("", 6, style), "      ");
	});
	it("clips a label that does not fit", () => {
		const header = groupHeader("a label far too long for the line", 16, style);
		assert.equal([...header].length, 16);
		assert.ok(header.includes("…"), header);
	});
});

describe("bodyLines", () => {
	it("opens each group with its header, a blank line before all but the first", () => {
		const labels: Record<number, string> = { 1: "first ask", 2: "second ask" };
		const lines = bodyLines(
			[1, 2],
			[entry({ id: "a", name: "read", group: 1 }), entry({ id: "b", name: "read", group: 1 }), entry({ id: "c", name: "read", group: 2 })],
			20,
			style,
			(group) => labels[group] ?? "",
		);
		assert.deepEqual(lines, [" first ask          ", "○ … read", "○ … read", "", " second ask         ", "○ … read"]);
	});

	it("lists a turn without calls under its header, and groups unlisted entries on their own", () => {
		const labels: Record<number, string> = { 1: "just chatting", 2: "do a thing" };
		const lines = bodyLines([1, 2], [entry({ id: "a", name: "read", group: 2 }), entry({ id: "z", name: "read", group: 3 })], 20, style, (g) => labels[g] ?? "");
		assert.deepEqual(lines, [" just chatting      ", "(no actions)", "", " do a thing         ", "○ … read", "", "                    ", "○ … read"]);
	});
});

describe("viewportTop", () => {
	it("pins to the end and clamps manual offsets", () => {
		assert.equal(viewportTop(50, 10, 0, true), 40);
		assert.equal(viewportTop(50, 10, 45, false), 40);
		assert.equal(viewportTop(50, 10, -3, false), 0);
		assert.equal(viewportTop(5, 10, 3, false), 0);
	});
});

describe("selectedText", () => {
	it("takes the first line from the start column and the last through the end column", () => {
		const lines = ["abcdef", "ghijkl", "mnopqr"];
		assert.equal(selectedText(lines, { anchor: { line: 0, col: 2 }, focus: { line: 2, col: 1 } }), "cdef\nghijkl\nmn");
		assert.equal(selectedText(lines, { anchor: { line: 1, col: 3 }, focus: { line: 1, col: 1 } }), "hij");
	});
});

describe("ActionsPanel", () => {
	const theme = { ...style, bg: (_c: unknown, t: string) => t } as unknown as ConstructorParameters<typeof ActionsPanel>[0]["theme"];

	function panel(entries: ActionEntry[], rows: number) {
		let closed = false;
		let renders = 0;
		const written: string[] = [];
		const component = new ActionsPanel({
			entries: () => entries,
			rows: () => rows,
			requestRender: () => renders++,
			theme,
			terminal: { write: (data: string) => written.push(data) },
			done: () => {
				closed = true;
			},
		});
		return { component, isClosed: () => closed, renders: () => renders, written };
	}

	function mouse(type: "press" | "drag" | "release" | "click" | "wheel", x: number, y: number, extra: Record<string, unknown> = {}) {
		return { type, button: "left" as const, x, y, screenX: x, screenY: y, width: 0, height: 0, shift: false, alt: false, ctrl: false, ...extra };
	}

	it("fills the terminal height with a framed view that follows the end", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "read", args: { path: `f${i}` } }));
		const { component } = panel(entries, 6);
		const lines = component.render(30);
		component.dispose();
		assert.equal(lines.length, 6);
		assert.ok(lines[0]!.startsWith("╭"));
		assert.ok(lines.at(-1)!.startsWith("╰"));
		assert.ok(lines[1]!.includes("read f3"), lines[1]);
		assert.ok(lines[3]!.includes("read f5"), lines[3]);
		assert.equal(lines[4]!.trim(), "│                            │".trim(), lines[4]);
		assert.ok(lines.at(-1)!.includes("↑↓ scroll"), lines.at(-1));
		for (const line of lines) assert.equal([...line].length, 30, line);
	});

	it("scrolls up and stops following, then End pins again", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "read", args: { path: `f${i}` } }));
		const { component } = panel(entries, 5);
		component.render(30);
		component.handleInput("up");
		assert.ok(component.render(30)[1]!.includes("read f3"));
		component.handleInput("end");
		assert.ok(component.render(30)[1]!.includes("read f4"));
		component.dispose();
	});

	it("pans sideways with the arrows, clamped to the widest line, and 0 resets", () => {
		const entries = [entry({ id: "a", name: "bash", args: { command: "echo " + "x".repeat(60) } })];
		const { component } = panel(entries, 5);
		component.render(30);
		component.handleInput("right");
		let lines = component.render(40);
		assert.ok(lines[2]!.startsWith("│ ho " + "x".repeat(8)), lines[2]);
		assert.ok(lines.at(-1)!.includes("→ 8"), lines.at(-1));
		for (let i = 0; i < 20; i++) component.handleInput("right");
		lines = component.render(30);
		assert.ok(lines[2]!.includes("x".repeat(20)), lines[2]);
		component.handleInput("0");
		assert.ok(component.render(30)[2]!.includes("$ echo"), component.render(30)[2]);
		component.dispose();
	});

	it("selects by drag inside the body, highlights it, and copies on release", () => {
		const entries = [entry({ id: "a", name: "read", args: { path: "first" } }), entry({ id: "b", name: "read", args: { path: "second" } })];
		const { component, written } = panel(entries, 6);
		component.render(40);
		assert.deepEqual(component.handleMouse(mouse("press", 2, 2)), { capture: true, handled: true, render: true });
		component.handleMouse(mouse("drag", 9, 3));
		const lines = component.render(40);
		assert.ok(lines[2]!.includes("[○ … read first"), lines[2]);
		assert.ok(lines[3]!.includes("[○ … read"), lines[3]);
		component.handleMouse(mouse("release", 9, 3));
		component.dispose();
		assert.equal(written.length, 1);
		const payload = written[0]!.match(/52;c;([^\x07]+)/)![1]!;
		assert.equal(Buffer.from(payload, "base64").toString("utf8"), "○ … read first\n○ … read");
	});

	it("copies a whole line on double click", () => {
		const { component, written } = panel([entry({ id: "a", name: "read", args: { path: "f.ts" } })], 6);
		component.render(40);
		component.handleMouse(mouse("click", 5, 2, { clickCount: 2 }));
		const lines = component.render(40);
		component.dispose();
		assert.ok(lines[2]!.includes("[○ … read f.ts"), lines[2]);
		const payload = written[0]!.match(/52;c;([^\x07]+)/)![1]!;
		assert.equal(Buffer.from(payload, "base64").toString("utf8"), "○ … read f.ts");
	});

	it("pans with shift+wheel and scrolls with a plain wheel", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "bash", args: { command: "echo " + "x".repeat(60) } }));
		const { component } = panel(entries, 5);
		component.render(40);
		component.handleMouse(mouse("wheel", 5, 2, { wheelDelta: -1, shift: true }));
		let lines = component.render(40);
		assert.ok(lines.at(-1)!.includes("→ 8"), lines.at(-1));
		component.handleMouse(mouse("wheel", 5, 2, { wheelDelta: 1, shift: true }));
		component.handleMouse(mouse("wheel", 5, 2, { wheelDelta: -1 }));
		lines = component.render(40);
		assert.ok(!lines.at(-1)!.includes("→ 8"), lines.at(-1));
		assert.ok(lines[1]!.includes("$ echo"), lines[1]);
		component.dispose();
	});

	it("takes its share of the terminal height, floored", () => {
		assert.equal(panelRows(40), 32);
		assert.equal(panelRows(6), 6);
		assert.equal(panelRows(9), 8);
	});

	it("ignores a press on the frame", () => {
		const { component } = panel([entry({ id: "a", name: "read" })], 6);
		component.render(40);
		assert.deepEqual(component.handleMouse(mouse("press", 0, 0)), { capture: false, handled: true, render: true });
		component.dispose();
	});

	it("closes on escape, q, and space", () => {
		for (const key of ["escape", "q", "space"]) {
			const { component, isClosed } = panel([], 5);
			component.handleInput(key);
			component.dispose();
			assert.equal(isClosed(), true, key);
		}
	});
});

describe("bodyLayout", () => {
	it("rules between steps and records where each step and group begins", () => {
		const layout = bodyLayout(
			[1],
			[
				entry({ id: "a", name: "read", group: 1, step: 1 }),
				entry({ id: "a/1", name: "read", group: 1, step: 1, parentId: "a" }),
				entry({ id: "b", name: "read", group: 1, step: 2 }),
				entry({ id: "c", name: "read", group: 2, step: 3 }),
			],
			20,
			style,
		);
		assert.deepEqual(layout.lines, [
			"                    ",
			"○ … read",
			"  ○ … read",
			"┈┈┈┈┈┈┈┈",
			"○ … read",
			"",
			"                    ",
			"○ … read",
		]);
		assert.deepEqual([...layout.stepAt], [[1, 1], [2, 4], [3, 7]]);
		assert.deepEqual([...layout.groupAt], [[1, 0], [2, 6]]);
	});
});
