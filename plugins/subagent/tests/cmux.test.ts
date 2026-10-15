import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCommand, createCmuxProgress, progressArgs, progressEnabled, type ProgressRegistry } from "../extensions/cmux.ts";
import type { Run, RunState } from "../extensions/types.ts";

const ENV = { CMUX_WORKSPACE_ID: "ws-1" };

/** Let the in-flight command's promise settle so the next pending command flushes. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A registry stub whose runs the test mutates, with `change()` to fire the listeners. */
function fakeRegistry() {
	const listeners = new Set<(run: Run) => void>();
	const runs = new Map<string, Run>();
	const set = (id: string, state: RunState) => {
		const run = (runs.get(id) ?? { id, state }) as Run;
		run.state = state;
		runs.set(id, run);
		for (const fn of [...listeners]) fn(run);
	};
	const registry: ProgressRegistry = {
		on: (_event, fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		list: () => [...runs.values()],
	};
	return { registry, set, listenerCount: () => listeners.size };
}

/** A runner that records each call and resolves when the test releases it. */
function recorder(manual = false) {
	const calls: string[][] = [];
	const releases: (() => void)[] = [];
	const run = (args: string[]) => {
		calls.push(args);
		if (!manual) return Promise.resolve();
		return new Promise<void>((resolve) => releases.push(resolve));
	};
	const release = async () => {
		releases.shift()?.();
		await new Promise((r) => setImmediate(r));
	};
	return { calls, run, release };
}

test("progressEnabled needs a workspace and un-silenced hooks", () => {
	assert.equal(progressEnabled({}), false);
	assert.equal(progressEnabled({ CMUX_WORKSPACE_ID: " " }), false);
	assert.equal(progressEnabled({ CMUX_WORKSPACE_ID: "ws", CMUX_PI_HOOKS_DISABLED: "1" }), false);
	assert.equal(progressEnabled({ CMUX_WORKSPACE_ID: "ws" }), true);
});

test("batchCommand reads done over total and clears when nothing is live", () => {
	assert.deepEqual(batchCommand(0, 0), { kind: "clear" });
	assert.deepEqual(batchCommand(0, 3), { kind: "clear" });
	assert.deepEqual(batchCommand(3, 3), { kind: "set", value: 0, label: "0/3 agents" });
	assert.deepEqual(batchCommand(1, 4), { kind: "set", value: 0.75, label: "3/4 agents" });
});

test("progressArgs targets the workspace explicitly", () => {
	assert.deepEqual(progressArgs({ kind: "clear" }, "ws-1"), ["clear-progress", "--workspace", "ws-1"]);
	assert.deepEqual(progressArgs({ kind: "set", value: 1 / 3, label: "1/3 agents" }, "ws-1"), [
		"set-progress",
		"0.33",
		"--label",
		"1/3 agents",
		"--workspace",
		"ws-1",
	]);
});

test("a batch opens with the first live run, counts settles, and clears when none is left", async () => {
	const { registry, set } = fakeRegistry();
	const { calls, run } = recorder();
	createCmuxProgress(registry, { env: ENV, run });
	assert.deepEqual(calls, [], "nothing published while no run is live");

	set("a", "queued");
	await tick();
	set("b", "running");
	await tick();
	set("a", "running");
	await tick();
	assert.deepEqual(calls.at(-1), ["set-progress", "0.00", "--label", "0/2 agents", "--workspace", "ws-1"]);
	assert.equal(calls.length, 2, "an unchanged batch is not resent");

	set("a", "done");
	await tick();
	assert.deepEqual(calls.at(-1), ["set-progress", "0.50", "--label", "1/2 agents", "--workspace", "ws-1"]);

	set("c", "running");
	await tick();
	assert.deepEqual(calls.at(-1), ["set-progress", "0.33", "--label", "1/3 agents", "--workspace", "ws-1"]);

	set("b", "paused");
	await tick();
	set("c", "failed");
	await tick();
	assert.deepEqual(calls.at(-1), ["clear-progress", "--workspace", "ws-1"]);
	const before = calls.length;

	set("b", "running");
	await tick();
	assert.deepEqual(calls.at(-1), ["set-progress", "0.00", "--label", "0/1 agents", "--workspace", "ws-1"], "a new batch starts fresh");
	assert.equal(calls.length, before + 1);
});

test("commands are serialized and coalesced to the latest state", async () => {
	const { registry, set } = fakeRegistry();
	const { calls, run, release } = recorder(true);
	createCmuxProgress(registry, { env: ENV, run });

	set("a", "running");
	set("b", "running");
	set("a", "done");
	assert.equal(calls.length, 1, "later changes wait for the in-flight command");
	await release();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], ["set-progress", "0.50", "--label", "1/2 agents", "--workspace", "ws-1"]);
	await release();
	assert.equal(calls.length, 2);
});

test("dispose unsubscribes and clears an open batch once", async () => {
	const { registry, set, listenerCount } = fakeRegistry();
	const { calls, run } = recorder();
	const dispose = createCmuxProgress(registry, { env: ENV, run });
	set("a", "running");
	await tick();
	dispose();
	await tick();
	assert.equal(listenerCount(), 0);
	assert.deepEqual(calls.at(-1), ["clear-progress", "--workspace", "ws-1"]);
	const count = calls.length;
	dispose();
	set("b", "running");
	assert.equal(calls.length, count);
});

test("dispose with no batch open sends nothing", () => {
	const { registry } = fakeRegistry();
	const { calls, run } = recorder();
	createCmuxProgress(registry, { env: ENV, run })();
	assert.deepEqual(calls, []);
});

test("outside a cmux workspace the reporter is inert", () => {
	const { registry, set, listenerCount } = fakeRegistry();
	const { calls, run } = recorder();
	createCmuxProgress(registry, { env: {}, run });
	set("a", "running");
	assert.equal(listenerCount(), 0);
	assert.deepEqual(calls, []);
});
