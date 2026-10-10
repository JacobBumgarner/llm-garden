import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { PAUSE_NOTICE } from "../../ask/extensions/pause.ts";
import {
	COALESCE_MS,
	type CourierRegistry,
	createCourier,
	NOTICE_HEADER,
	RESULT_MESSAGE_TYPE,
	stripNoticeHeader,
} from "../extensions/courier.ts";
import { PER_TASK_OUTPUT_CAP } from "../extensions/format.ts";
import type { Run } from "../extensions/types.ts";

const reply = (text: string) =>
	({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }) as unknown as Message;

const QUESTIONS = [{ id: "scope", question: "Which scope?", options: [{ label: "All" }, { label: "Some" }] }];

let nextId = 0;

/** Build a settled background run that no wait has claimed. */
function makeRun(overrides: Partial<Run> = {}): Run {
	nextId += 1;
	return {
		id: `sub-${nextId}`,
		label: "Do the thing",
		agent: "worker",
		agentSource: "user",
		task: "do it",
		state: "done",
		background: true,
		notify: "wake",
		delivered: false,
		messages: [reply("finished")],
		turnStart: 0,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
		lastActivity: 0,
		startedAt: 0,
		stderr: "",
		waiters: 0,
		...overrides,
	};
}

/** A registry stand-in that emits changes on demand and records `markDelivered`. */
class FakeRegistry implements CourierRegistry {
	closed = false;
	readonly marked: string[] = [];
	private readonly listeners = new Set<(run: Run) => void>();
	private readonly runs = new Map<string, Run>();

	on(_event: "change", fn: (run: Run) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	markDelivered(id: string): void {
		this.marked.push(id);
		const run = this.runs.get(id);
		if (run) run.delivered = true;
	}

	isClosed(): boolean {
		return this.closed;
	}

	emit(run: Run): void {
		this.runs.set(run.id, run);
		for (const listener of [...this.listeners]) listener(run);
	}
}

type SentCall = { message: { customType: string; content: unknown; display: boolean; details?: any }; options?: any };

function setupMidTurn(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const registry = new FakeRegistry();
	const sent: SentCall[] = [];
	const pi = { sendMessage: (message: SentCall["message"], options?: unknown) => sent.push({ message, options }) };
	let idle = false;
	const turnEnds = new Set<() => void>();
	const dispose = createCourier(registry, pi as never, {
		isIdle: () => idle,
		onTurnEnd: (fn) => {
			turnEnds.add(fn);
			return () => {
				turnEnds.delete(fn);
			};
		},
	});
	t.after(dispose);
	return {
		registry,
		sent,
		dispose,
		turnEnds,
		tick: (ms: number) => t.mock.timers.tick(ms),
		endTurn() {
			idle = true;
			for (const fn of [...turnEnds]) fn();
		},
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

function setup(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const registry = new FakeRegistry();
	const sent: SentCall[] = [];
	const pi = { sendMessage: (message: SentCall["message"], options?: unknown) => sent.push({ message, options }) };
	const dispose = createCourier(registry, pi as never);
	t.after(dispose);
	return { registry, sent, dispose, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test("runs settling 300 ms apart go out as one message one second after the first", (t) => {
	const { registry, sent, tick } = setup(t);
	const first = makeRun();
	const second = makeRun({ agent: "scout" });
	registry.emit(first);
	tick(300);
	registry.emit(second);
	tick(COALESCE_MS - 301);
	assert.equal(sent.length, 0);
	tick(1);
	assert.equal(sent.length, 1);
	const { message } = sent[0];
	assert.equal(message.customType, RESULT_MESSAGE_TYPE);
	assert.equal(message.display, true);
	assert.match(message.content as string, new RegExp(`### ${first.id} \\[worker\\] done`));
	assert.match(message.content as string, new RegExp(`### ${second.id} \\[scout\\] done`));
	assert.deepEqual(
		message.details.runs.map((run: { sessionId: string; agent: string; state: string }) => [run.sessionId, run.agent, run.state]),
		[
			[first.id, "worker", "done"],
			[second.id, "scout", "done"],
		],
	);
	assert.equal(message.details.runs[0].usage.input, 10);
	assert.equal(message.details.runs[0].label, first.label);
	assert.deepEqual(registry.marked, [first.id, second.id]);
	assert.equal(first.delivered, true);
	tick(COALESCE_MS * 5);
	assert.equal(sent.length, 1, "a delivered run is not posted again");
});

test("a batch with a wake run follows up and triggers a turn", (t) => {
	const { registry, sent, tick } = setup(t);
	registry.emit(makeRun({ notify: "quiet" }));
	registry.emit(makeRun({ notify: "wake" }));
	tick(COALESCE_MS);
	assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("an all-quiet batch waits for the next turn", (t) => {
	const { registry, sent, tick } = setup(t);
	registry.emit(makeRun({ notify: "quiet" }));
	registry.emit(makeRun({ notify: "quiet" }));
	tick(COALESCE_MS);
	assert.deepEqual(sent[0].options, { deliverAs: "nextTurn" });
});

test("runs claimed by a wait, already delivered, in the foreground, or still running are skipped", (t) => {
	const { registry, sent, tick } = setup(t);
	registry.emit(makeRun({ waiters: 1 }));
	registry.emit(makeRun({ delivered: true }));
	registry.emit(makeRun({ background: false }));
	registry.emit(makeRun({ state: "running" }));
	registry.emit(makeRun({ state: "queued" }));
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0);
});

test("a run a wait claims before the timer fires is left to the wait", (t) => {
	const { registry, sent, tick } = setup(t);
	const claimed = makeRun();
	const other = makeRun();
	registry.emit(claimed);
	registry.emit(other);
	claimed.waiters = 1;
	tick(COALESCE_MS);
	assert.equal(sent.length, 1);
	assert.deepEqual(
		sent[0].message.details.runs.map((run: { sessionId: string }) => run.sessionId),
		[other.id],
	);
});

test("each section is capped and names the session holding the full transcript", (t) => {
	const { registry, sent, tick } = setup(t);
	const big = makeRun({ messages: [reply("x".repeat(PER_TASK_OUTPUT_CAP * 2))] });
	const small = makeRun();
	registry.emit(big);
	registry.emit(small);
	tick(COALESCE_MS);
	const sections = (sent[0].message.content as string).split("\n\n---\n\n");
	assert.equal(sections.length, 2);
	assert.ok(Buffer.byteLength(sections[0], "utf8") < PER_TASK_OUTPUT_CAP + 500);
	assert.match(sections[0], new RegExp(`Output truncated: .* The full transcript is in subagent session ${big.id}\\.`));
	assert.doesNotMatch(sections[1], /Output truncated/);
});

test("a paused run's section carries its questions and the resume call", (t) => {
	const { registry, sent, tick } = setup(t);
	const run = makeRun({
		state: "paused",
		paused: QUESTIONS,
		messages: [
			{ role: "toolResult", toolCallId: "c1", toolName: "ask", content: [{ type: "text", text: PAUSE_NOTICE }] } as never,
		],
	});
	registry.emit(run);
	tick(COALESCE_MS);
	const content = sent[0].message.content as string;
	assert.match(content, /status: paused/);
	assert.match(content, /Which scope\?/);
	assert.ok(content.includes(`subagent({ action: "resume", id: "${run.id}", answers:`));
});

test("dispose drops the pending batch and later changes", (t) => {
	const { registry, sent, tick, dispose } = setup(t);
	registry.emit(makeRun());
	dispose();
	registry.emit(makeRun());
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0);
});

test("nothing is posted once the registry is closed", (t) => {
	const { registry, sent, tick } = setup(t);
	registry.emit(makeRun());
	registry.closed = true;
	tick(COALESCE_MS);
	assert.equal(sent.length, 0);
});

test("a run settling mid-turn and collected by a wait before the turn ends is not posted", (t) => {
	const { registry, sent, tick, endTurn } = setupMidTurn(t);
	const run = makeRun();
	registry.emit(run);
	tick(COALESCE_MS * 5);
	assert.equal(sent.length, 0, "held while the turn runs");
	run.delivered = true;
	endTurn();
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0);
});

test("a run settling mid-turn and not collected is posted one second after the turn ends", (t) => {
	const { registry, sent, tick, endTurn } = setupMidTurn(t);
	const run = makeRun();
	registry.emit(run);
	tick(COALESCE_MS * 5);
	endTurn();
	assert.equal(sent.length, 0);
	tick(COALESCE_MS);
	assert.equal(sent.length, 1);
	assert.deepEqual(registry.marked, [run.id]);
});

test("a turn that begins before the timer fires holds the batch until the next idle turn end", (t) => {
	const { registry, sent, tick, endTurn, setIdle } = setupMidTurn(t);
	const run = makeRun();
	registry.emit(run);
	endTurn();
	setIdle(false);
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0, "a new run started before the timer fired");
	run.delivered = true;
	endTurn();
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0, "the model collected it during that run");
});

test("a batch held through a run is posted once the next turn ends unclaimed", (t) => {
	const { registry, sent, tick, endTurn, setIdle } = setupMidTurn(t);
	const run = makeRun();
	registry.emit(run);
	endTurn();
	setIdle(false);
	tick(COALESCE_MS * 2);
	endTurn();
	tick(COALESCE_MS);
	assert.equal(sent.length, 1);
});

test("a turn end with nothing pending arms nothing", (t) => {
	const { sent, tick, endTurn } = setupMidTurn(t);
	endTurn();
	tick(COALESCE_MS * 2);
	assert.equal(sent.length, 0);
});

test("a run settling while idle is posted after one second", (t) => {
	const { registry, sent, tick, setIdle } = setupMidTurn(t);
	setIdle(true);
	registry.emit(makeRun());
	tick(COALESCE_MS - 1);
	assert.equal(sent.length, 0);
	tick(1);
	assert.equal(sent.length, 1);
});

test("dispose unsubscribes from the turn end", (t) => {
	const { registry, turnEnds, dispose } = setupMidTurn(t);
	registry.emit(makeRun());
	assert.equal(turnEnds.size, 1);
	dispose();
	assert.equal(turnEnds.size, 0);
});

test("the message opens with the notice header, in the plural for several runs", (t) => {
	const { registry, sent, tick } = setup(t);
	const one = makeRun();
	registry.emit(one);
	tick(COALESCE_MS);
	const single = sent[0].message.content as string;
	assert.ok(single.startsWith(`${NOTICE_HEADER}\n\n### ${one.id}`));

	registry.emit(makeRun());
	registry.emit(makeRun());
	tick(COALESCE_MS);
	const plural = sent[1].message.content as string;
	assert.ok(
		plural.startsWith(
			"[subagent tool] Background runs finished. This is an automated notice, not a message from the user.\n\n###",
		),
	);
	assert.ok(!stripNoticeHeader(plural).includes("automated notice"));
	assert.ok(stripNoticeHeader(plural).startsWith("###"));
});
