import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { ACTIVITY_EVENT, type ActivityEvent, type ActivityRegistry, createActivityFeed } from "../extensions/activity.ts";
import type { Run } from "../extensions/types.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as unknown as Message;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as unknown as Message;

function makeRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "sub-1",
		label: "Do the thing",
		agent: "worker",
		agentSource: "user",
		task: "do it",
		callId: "call-1",
		state: "running",
		background: false,
		notify: "wake",
		delivered: false,
		messages: [],
		turnStart: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		lastActivity: 0,
		startedAt: 0,
		stderr: "",
		waiters: 0,
		...overrides,
	};
}

class FakeRegistry implements ActivityRegistry {
	private readonly listeners = new Set<(run: Run) => void>();
	on(_event: "change", fn: (run: Run) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	emit(run: Run): void {
		for (const fn of [...this.listeners]) fn(run);
	}
}

function setup() {
	const registry = new FakeRegistry();
	const events: { name: string; data: ActivityEvent }[] = [];
	const dispose = createActivityFeed(registry, { emit: (name, data) => events.push({ name, data: data as ActivityEvent }) });
	return { registry, events, dispose };
}

test("emits each new non-user message once, keyed by the run and its call", () => {
	const { registry, events } = setup();
	const run = makeRun({ messages: [user("Task: do it")] });
	registry.emit(run);
	assert.equal(events.length, 1, "the first change publishes progress only");
	assert.equal(events[0].data.message, undefined, "the task prompt is not published");
	run.messages.push(reply("looking"), reply("done"));
	registry.emit(run);
	registry.emit(run);
	assert.deepEqual(
		events.slice(1).map((e) => [e.name, e.data.runId, e.data.callId, e.data.agent, e.data.label]),
		[
			[ACTIVITY_EVENT, "sub-1", "call-1", "worker", "Do the thing"],
			[ACTIVITY_EVENT, "sub-1", "call-1", "worker", "Do the thing"],
		],
	);
	assert.equal((events[2].data.message as { content: { text: string }[] }).content[0].text, "done");
});

test("a resume's call replaces the one later messages carry", () => {
	const { registry, events } = setup();
	const run = makeRun({ messages: [reply("first")] });
	registry.emit(run);
	run.callId = "call-2";
	run.messages.push(user("Follow-up"), reply("second"));
	registry.emit(run);
	assert.deepEqual(
		events.map((e) => e.data.callId),
		["call-1", "call-2"],
	);
});

test("a change of state or usage without a new message emits one bare progress event", () => {
	const { registry, events } = setup();
	const run = makeRun();
	registry.emit(run);
	assert.equal(events.length, 1, "the first change publishes the run's state");
	assert.equal(events[0].data.message, undefined);
	registry.emit(run);
	assert.equal(events.length, 1, "nothing changed");
	run.state = "done";
	run.usage.cost = 0.5;
	registry.emit(run);
	assert.equal(events.length, 2);
	assert.equal(events[1].data.state, "done");
	assert.equal(events[1].data.usage.cost, 0.5);
	assert.equal(events[1].data.message, undefined);
	run.messages.push(reply("x"));
	registry.emit(run);
	assert.equal(events.length, 3, "a new message carries the progress, no bare event beside it");
	assert.ok(events[2].data.message);
});

test("dispose stops the feed", () => {
	const { registry, events, dispose } = setup();
	dispose();
	registry.emit(makeRun({ messages: [reply("x")] }));
	assert.equal(events.length, 0);
});
