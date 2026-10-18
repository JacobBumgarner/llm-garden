import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActionEntry } from "../extensions/log.ts";
import {
	ActionsPanel,
	bodyLayout,
	bodyLines,
	entryLines,
	groupHeader,
	type PanelStyle,
	panelRows,
	wrapRow,
} from "../extensions/panel.ts";

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

	it("draws long summaries at full length without a width, the error marker after them", () => {
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

	it("breaks a chained bash command one step per line, continuation under the command", () => {
		const done = entry({
			id: "a",
			name: "bash",
			args: { command: "cd x && make | tee log" },
			result: { text: "", details: undefined, isError: true },
			durationMs: 3000,
			tail: ["ok"],
		});
		assert.deepEqual(entryLines(done, style), ["● $ cd x error · 3s", "    && make", "    | tee log", "  │ ok"]);
	});

	// The pi-tui stub wraps per character, so these use unbroken tokens where word and character wrapping agree.
	it("wraps summary and tail rows to the width with a hanging indent", () => {
		const done = entry({
			id: "a",
			name: "read",
			args: { path: "/" + "p".repeat(30) },
			result: { text: "", details: undefined, isError: false },
			tail: ["t".repeat(20)],
		});
		assert.deepEqual(entryLines(done, style, 0, 20), [
			"● read /" + "p".repeat(12),
			"  " + "p".repeat(18),
			"  │ " + "t".repeat(16),
			"    " + "t".repeat(4),
		]);
	});
});

describe("wrapRow", () => {
	it("returns one row when the text fits or no width is given", () => {
		assert.deepEqual(wrapRow("> ", "short", 10), ["> short"]);
		assert.deepEqual(wrapRow("> ", "x".repeat(30), undefined), ["> " + "x".repeat(30)]);
	});

	it("hangs later rows under the text, not the prefix", () => {
		assert.deepEqual(wrapRow("● ", "a".repeat(25), 12), ["● " + "a".repeat(10), "  " + "a".repeat(10), "  " + "a".repeat(5)]);
	});

	it("clips instead of wrapping when the prefix leaves under ten columns", () => {
		assert.deepEqual(wrapRow(" ".repeat(8), "aaaa bbbb cccc", 16), [" ".repeat(8) + "aaaa bbbb cccc"]);
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
		assert.ok(lines[1]!.includes("read f4"), lines[1]);
		assert.ok(lines[2]!.includes("read f5"), lines[2]);
		assert.equal(lines[3]!.trim(), "│                            │".trim(), lines[3]);
		assert.ok(lines[4]!.includes("↑↓ scroll"), lines[4]);
		assert.match(lines.at(-1)!, /^╰─+╯$/, lines.at(-1));
		for (const line of lines) assert.equal([...line].length, 30, line);
	});

	it("scrolls up and stops following, then End pins again", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "read", args: { path: `f${i}` } }));
		const { component } = panel(entries, 6);
		component.render(30);
		component.handleInput("up");
		assert.ok(component.render(30)[1]!.includes("read f3"));
		component.handleInput("end");
		assert.ok(component.render(30)[1]!.includes("read f4"));
		component.dispose();
	});

	it("ignores g and G", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "read", args: { path: `f${i}` } }));
		const { component } = panel(entries, 6);
		component.render(30);
		component.handleInput("up");
		component.handleInput("g");
		assert.ok(component.render(30)[1]!.includes("read f3"), "g does not jump to the top");
		component.handleInput("G");
		assert.ok(component.render(30)[1]!.includes("read f3"), "G does not jump to the end");
		component.dispose();
	});

	it("wraps a long command across rows instead of clipping it", () => {
		const entries = [entry({ id: "a", name: "bash", args: { command: "echo " + "x".repeat(60) } })];
		const { component } = panel(entries, 8);
		const lines = component.render(40);
		component.dispose();
		assert.ok(lines[2]!.includes("$ echo"), lines[2]);
		assert.ok(lines[3]!.startsWith("│   x"), lines[3]);
		assert.ok(lines[4]!.startsWith("│   x"), lines[4]);
		const shown = lines.slice(2, 5).join("").match(/x/g)!.length;
		assert.equal(shown, 60);
		for (const line of lines) assert.equal([...line].length, 40, line);
	});

	it("selects by drag inside the body, highlights it, and copies on release", () => {
		const entries = [entry({ id: "a", name: "read", args: { path: "first" } }), entry({ id: "b", name: "read", args: { path: "second" } })];
		const { component, written } = panel(entries, 7);
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

	it("scrolls with the wheel", () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `${i}`, name: "read", args: { path: `f${i}` } }));
		const { component } = panel(entries, 6);
		component.render(40);
		component.handleMouse(mouse("wheel", 5, 2, { wheelDelta: -1 }));
		const lines = component.render(40);
		component.dispose();
		assert.ok(lines[1]!.includes("read f1"), lines[1]);
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
