import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { boxLines, openOverlay, type OverlayHost, OverlaySlot, type OverlaySpec } from "../overlay.ts";
import { outsideClickListener } from "../outside-click.ts";

const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`;
const BOUNDS = { row: 2, col: 10, width: 40, height: 12 };

/** A fake `ui.custom` that builds the component at once and records what pi would be told. */
function fakeUi() {
	const seen = {
		customCalls: 0,
		renders: 0,
		component: undefined as undefined | { render(w: number): string[]; handleMouse?(e: TuiMouseEvent): unknown; dispose?(): void; handleInput?(d: string): void },
		options: undefined as unknown,
		hidden: false,
		focuses: 0,
	};
	const handle = {
		setHidden: (value: boolean) => void (seen.hidden = value),
		isHidden: () => seen.hidden,
		focus: () => void seen.focuses++,
		getBounds: () => (seen.hidden ? undefined : BOUNDS),
	};
	const tui = { requestRender: () => void seen.renders++, terminal: { rows: 24, columns: 80, write() {} } };
	const theme = { fg: (_color: string, text: string) => text };
	const ui = {
		custom: (factory: (...args: unknown[]) => never, options: { onHandle?: (h: unknown) => void; overlayOptions?: unknown }) => {
			seen.customCalls++;
			seen.options = options.overlayOptions;
			return new Promise((resolve) => {
				seen.component = factory(tui, theme, {}, (result: unknown) => {
					seen.component?.dispose?.();
					resolve(result);
				});
				options.onHandle?.(handle);
			});
		},
	} as never;
	return { ui, seen };
}

/** A watch that stands in for the stdin one: the test feeds presses to `send`. */
function fakeWatch() {
	const state = { stopped: 0, send: (_data: string) => {} };
	const watch: OverlaySpec["watch"] = (bounds, onOutside) => {
		state.send = outsideClickListener(bounds, onOutside);
		return () => void state.stopped++;
	};
	return { watch, state };
}

function spec(over: Partial<OverlaySpec> & { lines?: string[]; mice?: TuiMouseEvent[]; hostOut?: (h: OverlayHost) => void } = {}): OverlaySpec {
	return {
		options: { anchor: "center" },
		title: () => "[T]",
		outsideClick: "close",
		build: (host) => {
			over.hostOut?.(host);
			return {
				render: (width) => (over.lines ?? ["a"]).map((l) => `${l}@${width}`),
				handleInput: () => {},
				handleMouse: (event) => {
					over.mice?.push(event);
					return { handled: true, capture: true };
				},
				invalidate: () => {},
			};
		},
		...over,
	};
}

const mouse = (type: TuiMouseEvent["type"], x: number, y: number) => ({ type, button: "left", x, y }) as TuiMouseEvent;

describe("boxLines", () => {
	it("draws rounded corners with the painted title on the top edge and fits every row", () => {
		const lines = boxLines(["short", "x".repeat(80)], 40, { title: " T ", border: (t) => t });
		assert.equal(lines.length, 4);
		assert.match(lines[0]!, /^╭─ T ─+╮$/);
		assert.match(lines[3]!, /^╰─+╯$/);
		for (const line of lines) assert.equal([...line].length, 40);
		assert.match(lines[1]!, /^│ short {31} │$/);
		assert.match(lines[2]!, /^│ x+… │$/);
	});

	it("paints the edges and leaves the title as given", () => {
		const lines = boxLines([""], 12, { title: "<t>", border: (t) => `[${t}]` });
		assert.equal(lines[0], "[╭─]<t>[──────╮]");
	});
});

describe("openOverlay", () => {
	it("draws the panel's lines inside the frame at the inner width", async () => {
		const { ui, seen } = fakeUi();
		const done = openOverlay(ui, spec({ lines: ["one", "two"], outsideClick: "none" }));
		const lines = seen.component!.render(20);
		assert.equal(lines.length, 4);
		assert.match(lines[0]!, /^╭─\[T\]─+╮$/);
		assert.equal(lines[1], "│ one@16" + " ".repeat(20 - 4 - 6) + " │");
		assert.match(lines[3]!, /^╰─+╯$/);
		seen.component!.dispose?.();
		void done;
	});

	it("passes the options to pi and shifts mouse events into the text area", async () => {
		const { ui, seen } = fakeUi();
		const mice: TuiMouseEvent[] = [];
		void openOverlay(ui, spec({ mice, outsideClick: "none" }));
		assert.deepEqual(seen.options, { anchor: "center" });
		seen.component!.render(20);
		seen.component!.handleMouse!(mouse("press", 5, 3));
		assert.deepEqual([mice[0]!.x, mice[0]!.y], [3, 2]);
	});

	it("swallows a mouse event on the frame unless a drag that began inside holds the mouse", () => {
		const { ui, seen } = fakeUi();
		const mice: TuiMouseEvent[] = [];
		void openOverlay(ui, spec({ mice, outsideClick: "none" }));
		seen.component!.render(20);
		for (const [x, y] of [[5, 0], [5, 2], [0, 1], [19, 1]] as const) {
			assert.deepEqual(seen.component!.handleMouse!(mouse("press", x, y)), { handled: true });
		}
		assert.equal(mice.length, 0);
		seen.component!.handleMouse!(mouse("press", 5, 1));
		seen.component!.handleMouse!(mouse("drag", 5, 0));
		assert.equal(mice.length, 2, "a captured drag reaches the panel over the frame");
	});

	it("hides the overlay while a dialog runs, then shows it and takes focus", async () => {
		const { ui, seen } = fakeUi();
		let host!: OverlayHost;
		void openOverlay(ui, spec({ hostOut: (h) => (host = h), outsideClick: "none" }));
		const result = await host.suspend(async () => {
			assert.equal(seen.hidden, true);
			assert.equal(host.isHidden(), true);
			return 7;
		});
		assert.equal(result, 7);
		assert.equal(seen.hidden, false);
		assert.equal(seen.focuses, 1);
	});

	it("closes on a press outside under the close policy and stops the watch", async () => {
		const { ui } = fakeUi();
		const { watch, state } = fakeWatch();
		const closed = openOverlay(ui, spec({ watch, outsideClick: "close" }));
		state.send(press(0, 5));
		await closed;
		assert.equal(state.stopped, 1);
	});

	it("ignores a press inside the bounds, on the frame included", async () => {
		const { ui, seen } = fakeUi();
		const { watch, state } = fakeWatch();
		void openOverlay(ui, spec({ watch, outsideClick: "close" }));
		state.send(press(10, 2));
		state.send(press(49, 13));
		assert.equal(state.stopped, 0);
		assert.equal(seen.hidden, false);
	});

	it("hides on a press outside under the hide policy and ignores presses while hidden", () => {
		const { ui, seen } = fakeUi();
		const { watch, state } = fakeWatch();
		let host!: OverlayHost;
		void openOverlay(ui, spec({ watch, outsideClick: "hide", hostOut: (h) => (host = h) }));
		state.send(press(0, 0));
		assert.equal(seen.hidden, true);
		assert.equal(state.stopped, 0, "hiding keeps the overlay open");
		seen.focuses = 0;
		state.send(press(0, 0));
		assert.equal(seen.hidden, true);
		host.show();
		assert.equal(seen.hidden, false);
		assert.equal(seen.focuses, 1);
	});

	it("starts no watch under the none policy", () => {
		const { ui } = fakeUi();
		let started = 0;
		void openOverlay(ui, spec({ outsideClick: "none", watch: () => (started++, () => {}) }));
		assert.equal(started, 0);
	});

	it("redraws on the refresh interval until the overlay is disposed", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			const { ui, seen } = fakeUi();
			void openOverlay(ui, spec({ refreshMs: 1000, outsideClick: "none" }));
			mock.timers.tick(3000);
			assert.equal(seen.renders, 3);
			seen.component!.dispose?.();
			mock.timers.tick(3000);
			assert.equal(seen.renders, 3);
		} finally {
			mock.timers.reset();
		}
	});

	it("runs the panel's dispose after the wrapper's", () => {
		const { ui, seen } = fakeUi();
		let disposed = 0;
		void openOverlay(ui, {
			...spec({ outsideClick: "none" }),
			build: () => ({ render: () => [], invalidate: () => {}, dispose: () => void disposed++ }),
		});
		seen.component!.dispose?.();
		assert.equal(disposed, 1);
	});
});

describe("OverlaySlot", () => {
	it("refuses a second open while one is open and clears when it closes", async () => {
		const { ui, seen } = fakeUi();
		const slot = new OverlaySlot();
		const first = slot.open(ui, spec({ outsideClick: "none" }));
		assert.ok(slot.active);
		await slot.open(ui, spec({ outsideClick: "none" }));
		assert.equal(seen.customCalls, 1);
		slot.close();
		await first;
		assert.equal(slot.active, undefined);
		void slot.open(ui, spec({ outsideClick: "none" }));
		assert.equal(seen.customCalls, 2);
		assert.ok(slot.active);
	});

	it("clears when an outside press closes the overlay", async () => {
		const { ui } = fakeUi();
		const { watch, state } = fakeWatch();
		const slot = new OverlaySlot();
		const opened = slot.open(ui, spec({ watch, outsideClick: "close" }));
		state.send(press(0, 0));
		await opened;
		assert.equal(slot.active, undefined);
	});
});
