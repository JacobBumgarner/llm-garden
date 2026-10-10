import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOverlayRow, listNewestFirst } from "../extensions/format.ts";
import type { Run } from "../extensions/types.ts";
import {
	boxLines,
	createBlurWatch,
	createLiveView,
	createStopAllHandler,
	entryCapacity,
	registerViewControls,
	RunListView,
	TOGGLE_KEY,
	type RunListDeps,
	type ViewContext,
	type ViewRegistry,
} from "../extensions/view.ts";

const NOW = 1_000_000;

function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "sub-ab12",
		label: "Check ask",
		agent: "glm",
		agentSource: "user",
		task: "task",
		state: "running",
		background: true,
		notify: "wake",
		delivered: false,
		messages: [],
		turnStart: 0,
		usage: { input: 12_000, output: 2_000, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 3 },
		lastActivity: NOW - 14_000,
		startedAt: NOW - 60_000,
		stderr: "",
		waiters: 0,
		...overrides,
	};
}

/** A registry stand-in with a mutable run list that records the calls made on it. */
class FakeRegistry implements ViewRegistry {
	runs: Run[] = [];
	calls: string[] = [];
	private readonly listeners = new Set<(run: Run) => void>();

	on(_event: "change", fn: (run: Run) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	listenerCount(): number {
		return this.listeners.size;
	}

	list(): Run[] {
		return this.runs;
	}

	async stop(id: string): Promise<void> {
		this.calls.push(`stop ${id}`);
	}

	async stopAll(): Promise<void> {
		this.calls.push("stopAll");
	}

	async send(id: string, text: string, mode: "steer" | "follow_up"): Promise<string> {
		this.calls.push(`send ${id} ${mode} ${text}`);
		return "queued";
	}

	async resume(id: string, input: { answers: Record<string, string> }): Promise<Run> {
		this.calls.push(`resume ${id} ${JSON.stringify(input.answers)}`);
		return this.runs[0];
	}

	emit(): void {
		for (const listener of [...this.listeners]) listener(this.runs[0]);
	}
}

/** A pi stand-in that records bus emissions and keeps the bus handlers and registrations. */
function fakePi() {
	const emitted: [string, unknown][] = [];
	const handlers = new Map<string, (data: unknown) => void>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, { description: string; handler: (ctx: unknown) => Promise<void> }>();
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => emitted.push([channel, data]),
			on: (channel: string, fn: (data: unknown) => void) => {
				handlers.set(channel, fn);
				return () => handlers.delete(channel);
			},
		},
		sendMessage: () => {},
		registerCommand: (name: string, options: never) => commands.set(name, options),
		registerShortcut: (key: string, options: never) => shortcuts.set(key, options),
	};
	const live = () => emitted.filter(([channel]) => channel === "subagent:live").map(([, data]) => data);
	return { pi: pi as never, emitted, handlers, commands, shortcuts, live };
}

function fakeCtx(mode: ViewContext["mode"] = "tui") {
	const notes: string[] = [];
	const confirms: string[] = [];
	const ctx = {
		mode,
		ui: {
			notify: (message: string, type?: string) => notes.push(`${type}: ${message}`),
			confirm: async (title: string, message: string) => {
				confirms.push(`${title}: ${message}`);
				return true;
			},
		},
	};
	return { ctx: ctx as never, notes, confirms };
}

test("the live event carries zero, one, and several runs, counting only queued, running, and paused", () => {
	const registry = new FakeRegistry();
	const { pi, live } = fakePi();
	createLiveView(pi, registry, () => undefined);
	assert.deepEqual(live().at(-1), { count: 0, runs: [] });
	registry.runs = [makeRun({ id: "a" })];
	registry.emit();
	assert.deepEqual(live().at(-1), { count: 1, runs: [{ id: "a", agent: "glm", label: "Check ask", state: "running" }] });
	registry.runs = [
		makeRun({ id: "a" }),
		makeRun({ id: "b", state: "paused" }),
		makeRun({ id: "c", state: "queued" }),
		makeRun({ id: "d", state: "done" }),
	];
	registry.emit();
	const last = live().at(-1) as { count: number; runs: { id: string; state: string }[] };
	assert.equal(last.count, 3);
	assert.deepEqual(last.runs.map((run) => `${run.id} ${run.state}`), ["a running", "b paused", "c queued"]);
	registry.runs = [makeRun({ state: "done" })];
	registry.emit();
	assert.deepEqual(live().at(-1), { count: 0, runs: [] });
});

test("dispose emits an empty list and stops listening", () => {
	const registry = new FakeRegistry();
	registry.runs = [makeRun()];
	const { pi, live, handlers } = fakePi();
	const dispose = createLiveView(pi, registry, () => undefined);
	dispose();
	assert.deepEqual(live().at(-1), { count: 0, runs: [] });
	const count = live().length;
	registry.emit();
	assert.equal(live().length, count);
	assert.equal(registry.listenerCount(), 0);
	assert.equal(handlers.has("subagent:open"), false);
});

test("subagent:open opens the overlay with the latest context in the terminal UI only", () => {
	const registry = new FakeRegistry();
	for (const [mode, opened] of [["tui", 1], ["rpc", 0]] as const) {
		const { pi, handlers } = fakePi();
		let customCalls = 0;
		const ctx = { mode, ui: { custom: async () => void customCalls++ } } as never;
		createLiveView(pi, registry, () => ctx);
		handlers.get("subagent:open")?.(undefined);
		assert.equal(customCalls, opened);
	}
});

test("/subagents stop runs stop-all without opening the overlay, and other arguments are an error", async () => {
	const registry = new FakeRegistry();
	registry.runs = [makeRun({ id: "a" })];
	const { pi, commands, shortcuts } = fakePi();
	registerViewControls(pi, () => registry);
	const command = commands.get("subagents");
	assert.ok(command);
	const { ctx, notes, confirms } = fakeCtx();
	let opened = false;
	(ctx as { ui: { custom?: unknown } }).ui.custom = async () => void (opened = true);
	await command.handler(" stop ", ctx);
	assert.deepEqual(registry.calls, ["stopAll"]);
	assert.deepEqual(confirms, ["Stop subagents: Stop 1 running subagent?"]);
	assert.equal(opened, false);
	await command.handler("kill", ctx);
	assert.deepEqual(notes, ['error: Unknown argument "kill". The only argument is "stop".']);
	assert.deepEqual(registry.calls, ["stopAll"]);
});

test("alt+a is the only shortcut and toggles the overlay like the bare command", async () => {
	const registry = new FakeRegistry();
	const { pi, shortcuts } = fakePi();
	registerViewControls(pi, () => registry);
	assert.deepEqual([...shortcuts.keys()], ["alt+a"]);
	assert.equal(shortcuts.get("alt+a")?.description, "Open or close the subagents overlay");
	let customCalls = 0;
	const { ctx } = fakeCtx();
	(ctx as { ui: { custom?: unknown } }).ui.custom = async () => void customCalls++;
	await shortcuts.get("alt+a")?.handler(ctx);
	assert.equal(customCalls, 1);
	assert.deepEqual(registry.calls, []);
});

test("alt+a opens the overlay when closed and closes it without reopening when open", async () => {
	const { pi, shortcuts, commands } = fakePi();
	registerViewControls(pi, () => new FakeRegistry());
	let customCalls = 0;
	let closeCalls = 0;
	const { ctx } = fakeCtx();
	(ctx as { ui: { custom?: unknown } }).ui.custom = (factory: (...args: unknown[]) => { dispose?: () => void }) => {
		customCalls++;
		return new Promise<void>((resolve) => {
			const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {
				closeCalls++;
				component.dispose?.();
				resolve();
			});
		});
	};
	const first = shortcuts.get("alt+a")?.handler(ctx);
	assert.equal(customCalls, 1);
	assert.equal(closeCalls, 0);
	await shortcuts.get("alt+a")?.handler(ctx);
	assert.equal(customCalls, 1);
	assert.equal(closeCalls, 1);
	await first;
	const reopened = commands.get("subagents")?.handler("", ctx);
	assert.equal(customCalls, 2);
	await commands.get("subagents")?.handler("", ctx);
	assert.equal(closeCalls, 2);
	await reopened;
});

test("alt+a notifies outside the terminal UI", async () => {
	const { pi, shortcuts } = fakePi();
	registerViewControls(pi, () => new FakeRegistry());
	const { ctx, notes } = fakeCtx("rpc");
	await shortcuts.get("alt+a")?.handler(ctx);
	assert.deepEqual(notes, ["warning: /subagents needs the terminal UI"]);
});

test("subagent:stop-all confirms and stops every live run in the terminal UI only, and dispose unsubscribes", () => {
	const registry = new FakeRegistry();
	registry.runs = [makeRun({ id: "a" })];
	const { pi, handlers } = fakePi();
	const tui = fakeCtx("tui");
	const rpc = fakeCtx("rpc");
	let current = rpc.ctx;
	const dispose = createLiveView(pi, registry, () => current);
	handlers.get("subagent:stop-all")?.(undefined);
	assert.deepEqual(rpc.confirms, []);
	current = tui.ctx;
	handlers.get("subagent:stop-all")?.(undefined);
	assert.deepEqual(tui.confirms, ["Stop subagents: Stop 1 running subagent?"]);
	dispose();
	assert.equal(handlers.has("subagent:stop-all"), false);
});

test("boxLines draws the title in the top edge and fits every row to the width", () => {
	const lines = boxLines(["short", "x".repeat(80)], 40, " subagents ", (text) => text);
	assert.equal(lines.length, 4);
	assert.match(lines[0], /^┌ subagents ─+┐$/);
	assert.match(lines[3], /^└─+┘$/);
	for (const line of lines) assert.equal(line.length, 40);
	assert.match(lines[1], /^│ short {31} │$/);
	assert.match(lines[2], /^│ x+… │$/);
});

/** Build an overlay over a fake registry with scripted dialog answers. */
function setupView() {
	const registry = new FakeRegistry();
	registry.runs = [
		makeRun({ id: "old", startedAt: NOW - 9_000 }),
		makeRun({ id: "new", startedAt: NOW - 1_000 }),
		makeRun({
			id: "ask",
			state: "paused",
			startedAt: NOW - 5_000,
			paused: [
				{ id: "q1", question: "Which scope?", options: [{ label: "All" }, { label: "Some" }] },
				{ id: "q2", question: "Why?", options: [] },
			],
		}),
	];
	const log = { confirms: [] as string[], inputs: [] as [string, string | undefined][], notes: [] as string[], posts: [] as string[], suspends: 0 };
	const script = { confirm: true, inputs: [] as (string | undefined)[] };
	let closed = 0;
	let renders = 0;
	let termRows = 100;
	const deps: RunListDeps = {
		registry,
		dialogs: {
			confirm: async (title, message) => {
				log.confirms.push(`${title}: ${message}`);
				return script.confirm;
			},
			input: async (title, placeholder) => {
				log.inputs.push([title, placeholder]);
				return script.inputs.shift();
			},
			notify: (message) => log.notes.push(message),
		},
		postNote: (content) => log.posts.push(content),
		close: () => closed++,
		requestRender: () => renders++,
		suspend: async (dialog) => {
			log.suspends++;
			return dialog();
		},
		now: () => NOW,
		rows: () => termRows,
		highlight: (text) => `[${text}]`,
		paint: (state, text) => `{${state}:${text}}`,
		dim: (text) => text,
	};
	const view = new RunListView(deps);
	const press = async (key: string) => {
		view.handleInput(key);
		await view.settled();
	};
	return {
		registry,
		view,
		log,
		script,
		press,
		closed: () => closed,
		renders: () => renders,
		setRows: (rows: number) => {
			termRows = rows;
		},
	};
}

test("rows list runs newest first with the selection marked and the key line last", () => {
	const { registry, view } = setupView();
	const lines = view.render(60);
	assert.deepEqual(
		listNewestFirst(registry.runs).map((run) => run.id),
		["new", "ask", "old"],
	);
	assert.equal(lines[0], "");
	assert.equal(lines[2], `  [> ${formatOverlayRow(makeRun({ id: "new", startedAt: NOW - 1_000 }), NOW, 56)}]`);
	assert.match(lines[3], /^ {4}\{paused:⏸\} glm ask {2}Check ask {2}\{paused:paused\}: 2 questions/);
	assert.match(lines[4], /^ {4}\{running:▶\} glm old /);
	assert.equal(lines.at(-1), "↑↓ select · s stop · m message · a answer · esc or alt+a close");
});

test("up and down move the selection and wrap", async () => {
	const { view, press } = setupView();
	await press("down");
	assert.match(view.render(60)[3], /^ {2}\[> ⏸/);
	await press("down");
	await press("down");
	assert.match(view.render(60)[2], /^ {2}\[> ▶ glm new/);
	await press("up");
	assert.match(view.render(60)[4], /^ {2}\[> ▶ glm old/);
});

test("escape closes the overlay", async () => {
	const { press, closed } = setupView();
	await press("escape");
	assert.equal(closed(), 1);
});

test("the blur watch reports lost focus only after the overlay was focused once and is not hidden", () => {
	const watch = createBlurWatch();
	const handle = { focused: false, hidden: false, isFocused: () => handle.focused, isHidden: () => handle.hidden };
	assert.equal(watch.lost(handle), false, "unfocused before the first focus");
	handle.focused = true;
	assert.equal(watch.lost(handle), false);
	handle.hidden = true;
	handle.focused = false;
	assert.equal(watch.lost(handle), false, "hidden behind a dialog");
	handle.hidden = false;
	assert.equal(watch.lost(handle), true, "focus moved elsewhere");
});

test("the toggle chord closes the overlay from inside, where the shortcut router cannot see it", async () => {
	const { press, closed } = setupView();
	await press(TOGGLE_KEY);
	assert.equal(closed(), 1);
});

test("a notice draws indented above the key line and clears on the next key", async () => {
	const { view, press } = setupView();
	view.showNotice("sub-x is done, so it cannot be steered");
	const lines = view.render(60);
	assert.equal(lines.at(-3), "  sub-x is done, so it cannot be steered");
	assert.equal(lines.at(-2), "");
	await press("down");
	assert.ok(!view.render(60).includes("sub-x is done, so it cannot be steered"));
});

test("s stops the selected run only after the confirm says yes", async () => {
	const { registry, log, script, press } = setupView();
	script.confirm = false;
	await press("s");
	assert.deepEqual(registry.calls, []);
	script.confirm = true;
	await press("s");
	assert.deepEqual(registry.calls, ["stop new"]);
	assert.deepEqual(log.confirms, ["Stop subagent: Stop glm new?", "Stop subagent: Stop glm new?"]);
	assert.equal(log.suspends, 2);
});

test("s on a finished run notifies instead of asking", async () => {
	const { registry, log, press } = setupView();
	registry.runs[1].state = "done";
	await press("down");
	await press("down");
	await press("s");
	assert.deepEqual(log.confirms, []);
	assert.deepEqual(log.notes, ["new already done"]);
});

test("m steers the selected run and posts a note, and an empty message does nothing", async () => {
	const { registry, log, script, press } = setupView();
	script.inputs = ["  ", "use the cache"];
	await press("m");
	assert.deepEqual(registry.calls, []);
	await press("m");
	assert.deepEqual(registry.calls, ["send new steer use the cache"]);
	assert.deepEqual(log.posts, ["User steered new: use the cache"]);
	assert.deepEqual(log.inputs[0], ["Message to new", undefined]);
});

test("m on a run that is not running notifies and opens no dialog", async () => {
	const { log, press } = setupView();
	await press("down");
	await press("m");
	assert.deepEqual(log.inputs, []);
	assert.deepEqual(log.notes, ["ask is paused, so it cannot be steered"]);
});

test("a asks one question per input with the options as the placeholder, then resumes and posts a note", async () => {
	const { registry, log, script, press } = setupView();
	await press("down");
	script.inputs = ["All", "because"];
	await press("a");
	assert.deepEqual(log.inputs, [
		["Which scope?", "All | Some"],
		["Why?", undefined],
	]);
	assert.deepEqual(registry.calls, ['resume ask {"q1":"All","q2":"because"}']);
	assert.deepEqual(log.posts, ["User answered ask's questions"]);
});

test("cancelling an answer input sends nothing", async () => {
	const { registry, log, script, press } = setupView();
	await press("down");
	script.inputs = ["All", undefined];
	await press("a");
	assert.deepEqual(registry.calls, []);
	assert.deepEqual(log.posts, []);
});

test("a on a running run notifies", async () => {
	const { log, press } = setupView();
	await press("a");
	assert.deepEqual(log.notes, ["new is not waiting for answers"]);
});

test("a registry failure from an action is reported and the overlay stays usable", async () => {
	const { registry, view, script, log, press } = setupView();
	registry.send = async () => {
		throw new Error("child gone");
	};
	script.inputs = ["hi"];
	await press("m");
	assert.deepEqual(log.notes, ["child gone"]);
	assert.deepEqual(log.posts, []);
	await press("down");
	assert.match(view.render(60)[3], /^ {2}\[> /);
});

test("the overlay re-renders on registry change and stops listening on dispose", () => {
	const { registry, view, renders } = setupView();
	const before = renders();
	registry.emit();
	assert.equal(renders(), before + 1);
	view.dispose();
	registry.emit();
	assert.equal(renders(), before + 1);
});

test("the selection clamps when runs disappear", () => {
	const { registry, view } = setupView();
	view.handleInput("up");
	registry.runs = [registry.runs[0]];
	registry.emit();
	assert.match(view.render(60)[2], /^ {2}\[> /);
});

test("stop-all notifies when nothing is live and confirms by count otherwise", async () => {
	const registry = new FakeRegistry();
	registry.runs = [makeRun({ state: "done" })];
	const confirms: string[] = [];
	const notes: string[] = [];
	let answer = false;
	const ctx = {
		ui: {
			notify: (message: string) => notes.push(message),
			confirm: async (title: string, message: string) => {
				confirms.push(`${title}: ${message}`);
				return answer;
			},
		},
	} as never;
	const handler = createStopAllHandler(() => registry);
	await handler(ctx);
	assert.deepEqual(notes, ["No running subagents"]);
	registry.runs = [makeRun({ id: "a" }), makeRun({ id: "b", state: "paused" })];
	await handler(ctx);
	assert.deepEqual(registry.calls, []);
	answer = true;
	await handler(ctx);
	assert.deepEqual(registry.calls, ["stopAll"]);
	assert.deepEqual(confirms, ["Stop subagents: Stop 2 running subagents?", "Stop subagents: Stop 2 running subagents?"]);
});

test("a list with both groups starts blank, titles each group, and the selection skips headers and the gap", async () => {
	const { registry, view, press } = setupView();
	registry.runs.push(
		makeRun({ id: "fin1", state: "done", startedAt: NOW - 2_000 }),
		makeRun({ id: "fin2", state: "failed", startedAt: NOW - 3_000 }),
	);
	const lines = view.render(60);
	assert.equal(lines[0], "");
	assert.match(lines[1], /^ {2}RUNNING/);
	assert.match(lines[2], /^  \[> ▶ glm new/);
	assert.match(lines[3], /^ {4}\{paused:⏸\} glm ask/);
	assert.equal(lines[5], "");
	assert.match(lines[6], /FINISHED/);
	assert.match(lines[7], /^ {4}\{done:✓\} glm fin1/);
	await press("down");
	await press("down");
	await press("down");
	assert.match(view.render(60)[7], /^  \[> ✓ glm fin1/);
	await press("up");
	assert.match(view.render(60)[4], /^  \[> ▶ glm old/);
	await press("down");
	await press("down");
	await press("s");
	assert.equal(registry.calls.length, 0, "a finished run is not stopped");
});

test("an empty group draws (none) under its header and the selection skips it", async () => {
	const { view, press } = setupView();
	const lines = view.render(60);
	assert.match(lines[6], /^ {2}FINISHED$/);
	assert.equal(lines[7], "  (none)");
	for (let i = 0; i < 3; i++) await press("down");
	assert.match(view.render(60)[2], /^ {2}\[> ▶ glm new/);
	await press("up");
	assert.match(view.render(60)[4], /^ {2}\[> ▶ glm old/);
});

test("an empty list draws both headers with (none) and ignores the arrow keys", async () => {
	const { registry, view, press } = setupView();
	registry.runs = [];
	const expected = ["", "  RUNNING", "  (none)", "", "  FINISHED", "  (none)"];
	assert.deepEqual(view.render(60).slice(0, 6), expected);
	await press("down");
	await press("up");
	assert.deepEqual(view.render(60).slice(0, 6), expected);
});

test("a list taller than the overlay scrolls with the selection and counts the hidden entries", async () => {
	const { registry, view, press, setRows } = setupView();
	registry.runs = Array.from({ length: 12 }, (_, index) => makeRun({ id: `r${index}`, startedAt: NOW - index * 1_000 }));
	setRows(25);
	const top = view.render(60);
	assert.equal(top.length, Math.floor(25 * 0.6) - 2, "the overlay's share of the terminal minus the box edges");
	assert.equal(entryCapacity(25, 0), top.length - 3);
	assert.match(top[1], /RUNNING/);
	assert.match(top.at(-3) ?? "", /^ {2}↓ \d+ more$/);
	assert.ok(!top.some((line) => /↑ \d+ more/.test(line)));
	for (let step = 0; step < 11; step++) await press("down");
	const bottom = view.render(60);
	assert.equal(bottom.length, top.length);
	assert.match(bottom[1], /^ {2}↑ \d+ more$/);
	assert.ok(bottom.some((line) => line.includes("[> ") && line.includes("r11")));
});

test("the selection stays visible when down passes the window", async () => {
	const { registry, view, press, setRows } = setupView();
	registry.runs = Array.from({ length: 12 }, (_, index) => makeRun({ id: `r${index}`, startedAt: NOW - index * 1_000 }));
	setRows(25);
	for (let step = 0; step < 8; step++) {
		await press("down");
		const lines = view.render(60);
		assert.equal(lines.filter((line) => line.includes("[> ")).length, 1);
		assert.ok(lines.length <= 13);
	}
	assert.match(view.render(60).join("\n"), /↑ \d+ more[\s\S]*↓ \d+ more/);
});
