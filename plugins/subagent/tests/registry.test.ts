import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatAnswersMessage, PAUSE_NOTICE } from "../../ask/extensions/pause.ts";
import type { AgentConfig } from "../extensions/agents.ts";
import { COALESCE_MS, createCourier } from "../extensions/courier.ts";
import {
	DONE_IDLE_MS,
	MAX_LIVE,
	MAX_RUNNING,
	PAUSED_IDLE_MS,
	type Run,
	type RunClient,
	RunRegistry,
	type RunSpec,
} from "../extensions/registry.ts";
import type { DelegateExit, PromptDisposition, QueuedInputDisposition } from "../extensions/rpc.ts";
import { readMeta, writeMeta } from "../extensions/session.ts";
import { buildChildArgs } from "../extensions/spawn.ts";

const AGENT: AgentConfig = {
	name: "worker",
	description: "test agent",
	systemPrompt: "Do the work.",
	source: "user",
	filePath: "/agents/worker.md",
};

const ASK_QUESTIONS = [{ id: "scope", question: "Which scope?", options: [{ label: "All" }, { label: "Some" }] }];

/** A scripted Delegate client: records commands, emits events on demand, and exits when stopped or told to. */
class FakeClient implements RunClient {
	readonly exited: Promise<DelegateExit>;
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	stderr = "";
	stopped = false;
	promptDisposition: PromptDisposition = "started";
	private resolveExit!: (exit: DelegateExit) => void;
	private readonly listeners = new Set<(ev: JsonAgentSessionEvent) => void>();

	readonly args: string[];
	readonly cwd: string;

	constructor(args: string[], cwd: string) {
		this.args = args;
		this.cwd = cwd;
		this.exited = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	async start(): Promise<void> {}

	async prompt(text: string): Promise<PromptDisposition> {
		this.prompts.push(text);
		return this.promptDisposition;
	}

	async steer(text: string): Promise<QueuedInputDisposition> {
		this.steers.push(text);
		return "queued";
	}

	async followUp(text: string): Promise<QueuedInputDisposition> {
		this.followUps.push(text);
		return "queued";
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.exit(0);
	}

	onEvent(fn: (ev: JsonAgentSessionEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	emit(event: Record<string, unknown>): void {
		for (const listener of [...this.listeners]) listener(event as JsonAgentSessionEvent);
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.resolveExit({ code, signal });
	}

	/** Emit a whole turn: start, each message, then settle. */
	turn(...messages: unknown[]): void {
		this.emit({ type: "agent_start" });
		for (const message of messages) this.emit({ type: "message_end", message });
		this.emit({ type: "agent_settled" });
	}
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason,
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
});
const askCall = (id: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "ask", arguments: { questions: ASK_QUESTIONS } }],
	stopReason: "toolUse",
});
const pauseResult = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "ask",
	content: [{ type: "text", text: PAUSE_NOTICE }],
	isError: false,
});

/** Let pending promise chains and file writes run. */
async function flush(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Build a registry over fake clients in a fresh session directory, closed and removed when the test ends. */
function setup(t: TestContext, options: { mockTime?: boolean } = {}) {
	if (options.mockTime) t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
	const clients: FakeClient[] = [];
	const changes: { id: string; state: string; delivered: boolean }[] = [];
	const make = () => {
		const registry = new RunRegistry({
			sessionDir,
			defaultCwd: "/work",
			findAgent: (name) => (name === AGENT.name ? AGENT : undefined),
			childArgs: async ({ agent, sessionId, label, dispatch }) => {
				const model = agent.model ?? dispatch?.model;
				return { args: buildChildArgs({ sessionDir, sessionId, label, model, tools: agent.tools, systemPromptFile: "/unused/prompt.md" }), model };
			},
			createClient: ({ args, cwd }) => {
				const client = new FakeClient(args, cwd);
				clients.push(client);
				return client;
			},
		});
		registry.on("change", (run) => changes.push({ id: run.id, state: run.state, delivered: run.delivered }));
		return registry;
	};
	const registry = make();
	t.after(async () => {
		await registry.close();
		fs.rmSync(sessionDir, { recursive: true, force: true });
	});
	const spec = (overrides: Partial<RunSpec> = {}): RunSpec => ({ label: "Do the thing", agent: AGENT, task: "do it", agentScope: "user", ...overrides });
	const clientOf = (run: Run) => run.client as FakeClient;
	const startMany = async (count: number) => {
		const runs: Run[] = [];
		for (let i = 0; i < count; i++) runs.push(await registry.start(spec({ background: true, task: `t${i}` })));
		return runs;
	};
	return { registry, make, sessionDir, clients, changes, spec, clientOf, startMany };
}

/** Wait until a session's meta file satisfies a predicate. */
async function metaEventually(sessionDir: string, id: string, check: (meta: ReturnType<typeof readMeta>) => boolean) {
	for (let i = 0; i < 100; i++) {
		const meta = readMeta(sessionDir, id);
		if (check(meta)) return meta;
		await flush(1);
	}
	assert.fail(`meta for ${id} never matched: ${JSON.stringify(readMeta(sessionDir, id))}`);
}

test("start launches a running child with rpc-ready args and sends the task", async (t) => {
	const { registry, clients, spec, sessionDir } = setup(t);
	const run = await registry.start(spec({ background: true }));
	assert.equal(run.state, "running");
	assert.equal(clients.length, 1);
	const { args, prompts, cwd } = clients[0];
	assert.equal(cwd, "/work");
	assert.ok(!args.includes("-p"), "the print flag would make the child exit after one prompt");
	assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", run.id]);
	assert.deepEqual(prompts, ["Task: do it"]);
	assert.equal(readMeta(sessionDir, run.id)?.agent, "worker");
});

test("start passes the label as the child's session name and saves it in the meta file", async (t) => {
	const { registry, clients, spec, sessionDir } = setup(t);
	const run = await registry.start(spec({ background: true, label: "Audit the store" }));
	const { args } = clients[0];
	assert.deepEqual(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2), ["--name", "Audit the store"]);
	assert.equal(run.label, "Audit the store");
	assert.equal(readMeta(sessionDir, run.id)?.label, "Audit the store");
});

test("resume with a new label renames the run and the meta file and names a respawned child", async (t) => {
	const { registry, clientOf, clients, spec, sessionDir } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const first = clientOf(run);
	first.turn(user("Task: do it"), reply("finished"));
	first.exit(0);
	await flush();

	await registry.resume(run.id, { task: "and more", label: "Second pass" });
	const { args } = clients[1];
	assert.deepEqual(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2), ["--name", "Second pass"]);
	assert.equal(run.label, "Second pass");
	await metaEventually(sessionDir, run.id, (meta) => meta?.label === "Second pass");
});

test("resume without a label keeps the run's label on a respawn", async (t) => {
	const { registry, clientOf, clients, spec } = setup(t);
	const run = await registry.start(spec({ background: true, label: "Audit the store" }));
	const first = clientOf(run);
	first.turn(user("Task: do it"), reply("finished"));
	first.exit(0);
	await flush();

	await registry.resume(run.id, { task: "and more" });
	const { args } = clients[1];
	assert.equal(args[args.indexOf("--name") + 1], "Audit the store");
	assert.equal(run.label, "Audit the store");
});

test("restore falls back to a task preview when the meta file has no label", async (t) => {
	const { make, sessionDir, clients } = setup(t);
	const task = `Refactor ${"x".repeat(100)}`;
	await writeMeta(sessionDir, "sub-legacy", { agent: "worker", task, agentScope: "user" });
	const fresh = make();
	t.after(() => fresh.close());
	const restored = await fresh.resume("sub-legacy", { task: "continue" });
	assert.match(restored.label, /^Refactor x+…$/);
	assert.ok(restored.label.length <= 60);
	assert.equal((clients.at(-1) as FakeClient).args[(clients.at(-1) as FakeClient).args.indexOf("--name") + 1], restored.label);
});

test("a settle with no waiter leaves the run undelivered and emits the change", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t);
	const run = await registry.start(spec({ background: true }));
	clientOf(run).turn(user("Task: do it"), reply("finished"));
	assert.equal(run.state, "done");
	assert.equal(run.delivered, false);
	assert.deepEqual(changes.at(-1), { id: run.id, state: "done", delivered: false });
	assert.equal(run.usage.turns, 1);
	assert.equal(run.usage.input, 10);
});

test("a settle with a pending wait resolves it and marks the run delivered", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t);
	const run = await registry.start(spec());
	const waiting = registry.wait([run.id]);
	assert.equal(run.waiters, 1);
	clientOf(run).turn(reply("finished"));
	assert.equal(run.delivered, true, "delivery is decided in the same step as the settle");
	assert.deepEqual(changes.at(-1), { id: run.id, state: "done", delivered: true });
	const [result] = await waiting;
	assert.equal(result, run);
	assert.equal(run.waiters, 0);
});

test("wait on an already terminal run resolves at once and marks it delivered", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec({ background: true }));
	clientOf(run).turn(reply("finished"));
	assert.equal(run.delivered, false);
	const [result] = await registry.wait([run.id]);
	assert.equal(result.state, "done");
	assert.equal(run.delivered, true);
	assert.equal(run.waiters, 0);
});

test("wait with no ids covers only queued and running runs", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const done = await registry.start(spec({ background: true }));
	clientOf(done).turn(reply("finished"));
	const running = await registry.start(spec());
	const waiting = registry.wait();
	assert.equal(done.waiters, 0);
	assert.equal(running.waiters, 1);
	clientOf(running).turn(reply("finished"));
	assert.deepEqual(await waiting, [running]);
});

test("wait hitting its timeout resolves with the current states", async (t) => {
	const { registry, spec } = setup(t, { mockTime: true });
	const run = await registry.start(spec());
	const waiting = registry.wait([run.id], 5_000);
	t.mock.timers.tick(4_999);
	assert.equal(run.waiters, 1);
	t.mock.timers.tick(1);
	const [result] = await waiting;
	assert.equal(result.state, "running");
	assert.equal(run.waiters, 0);
	assert.equal(run.delivered, false);
});

test("a timed-out wait makes its active runs background and leaves settled ones delivered", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t, { mockTime: true });
	const active = await registry.start(spec());
	const settled = await registry.start(spec());
	const waiting = registry.wait([active.id, settled.id], 5_000);
	clientOf(settled).turn(reply("finished"));
	t.mock.timers.tick(5_000);
	await waiting;
	assert.equal(active.background, true);
	assert.equal(settled.background, false);
	assert.equal(settled.delivered, true);
	assert.deepEqual(changes.at(-1), { id: active.id, state: "running", delivered: false });
	clientOf(active).turn(reply("finished"));
	assert.equal(active.delivered, false, "the later settle is left for the courier");
});

test("an aborted wait rejects and detach makes the run background so the later settle stays undelivered", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec());
	const controller = new AbortController();
	const waiting = registry.wait([run.id], undefined, controller.signal);
	controller.abort(new Error("esc"));
	await assert.rejects(waiting, /esc/);
	assert.equal(run.waiters, 1, "the caller releases its waiter through detach");
	registry.detach(run.id);
	assert.equal(run.waiters, 0);
	assert.equal(run.background, true);
	clientOf(run).turn(reply("finished"));
	assert.equal(run.state, "done");
	assert.equal(run.delivered, false);
});

test("a pre-aborted wait leaves waiters unchanged once detached, and detach never goes negative", async (t) => {
	const { registry, spec } = setup(t);
	const run = await registry.start(spec());
	const controller = new AbortController();
	controller.abort(new Error("esc"));
	await assert.rejects(registry.wait([run.id], undefined, controller.signal), /esc/);
	assert.equal(run.waiters, 1, "counted like any aborted wait, released by detach");
	registry.detach(run.id);
	assert.equal(run.waiters, 0);
	registry.detach(run.id);
	assert.equal(run.waiters, 0);
});

test("a pre-aborted wait does not release the waiter of another wait", async (t) => {
	const { registry, spec } = setup(t);
	const run = await registry.start(spec());
	const other = registry.wait([run.id]);
	const controller = new AbortController();
	controller.abort(new Error("esc"));
	await assert.rejects(registry.wait([run.id], undefined, controller.signal), /esc/);
	assert.equal(run.waiters, 2);
	registry.detach(run.id);
	assert.equal(run.waiters, 1, "the other wait keeps its waiter");
	void other;
});

test("resume without a live child is rejected when it would queue past the live cap", async (t) => {
	const { registry, spec, clientOf, startMany } = setup(t, { mockTime: true });
	const parked = await registry.start(spec({ background: true }));
	clientOf(parked).turn(askCall("c0"), pauseResult("c0"));
	t.mock.timers.tick(PAUSED_IDLE_MS);
	assert.equal(parked.client, undefined);
	for (let i = 0; i < MAX_LIVE - MAX_RUNNING; i++) {
		const run = await registry.start(spec({ background: true }));
		clientOf(run).turn(askCall(`p${i}`), pauseResult(`p${i}`));
		await flush();
	}
	await startMany(MAX_RUNNING);
	await assert.rejects(registry.resume(parked.id, { answers: { scope: "All" } }), /alive and none is finished/);
	assert.equal(parked.state, "paused");
});

test("resume is rejected while a wait on the run is pending", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const first = await registry.start(spec());
	const second = await registry.start(spec());
	const waiting = registry.wait([first.id, second.id]);
	clientOf(first).turn(reply("finished"));
	assert.equal(first.state, "done");
	assert.equal(first.waiters, 1);
	await assert.rejects(registry.resume(first.id, { task: "more" }), /pending wait/);
	clientOf(second).turn(reply("finished"));
	await waiting;
	await registry.resume(first.id, { task: "more" });
	assert.equal(first.state, "running");
});

test("resume into a live paused child sends the answers message", async (t) => {
	const { registry, spec, clientOf, clients } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(user("Task: do it"), askCall("c1"), pauseResult("c1"));
	assert.equal(run.state, "paused");
	const questions = run.paused ?? [];
	await registry.resume(run.id, { answers: { scope: "All" } });
	assert.equal(clients.length, 1);
	assert.equal(run.state, "running");
	assert.equal(run.turnStart, 3);
	assert.equal(client.prompts.at(-1), formatAnswersMessage(questions, { scope: "All" }));
});

test("resume into a live child queues while every running slot is taken", async (t) => {
	const { registry, spec, clientOf, clients, startMany } = setup(t);
	const paused = await registry.start(spec({ background: true }));
	const client = clientOf(paused);
	client.turn(askCall("c1"), pauseResult("c1"));
	const runs = await startMany(MAX_RUNNING);

	await registry.resume(paused.id, { answers: { scope: "All" } });
	assert.equal(paused.state, "queued");
	assert.equal(client.prompts.length, 1);

	clientOf(runs[0]).turn(reply("finished"));
	await flush();
	assert.equal(paused.state, "running");
	assert.equal(paused.client, client, "the live child is prompted in place");
	assert.equal(clients.length, MAX_RUNNING + 1);
	assert.match(client.prompts[1], /<orchestrator-answers>/);
});

test("resume respawns on the session file when the child is gone", async (t) => {
	const { registry, spec, clientOf, clients } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const first = clientOf(run);
	first.turn(user("Task: do it"), reply("finished"));
	first.exit(0);
	await flush();
	assert.equal(run.client, undefined);
	assert.equal(run.state, "done");

	await registry.resume(run.id, { task: "and more" });
	assert.equal(clients.length, 2);
	const { args, prompts } = clients[1];
	assert.deepEqual(args.slice(args.indexOf("--session-id"), args.indexOf("--session-id") + 2), ["--session-id", run.id]);
	assert.deepEqual(prompts, ["Follow-up task (continuing your previous work in this session): and more"]);
	assert.equal(run.state, "running");
	assert.equal(run.delivered, false);
	assert.equal(run.turnStart, 2);
	assert.equal(run.task, "and more");
});

test("resume of a session this registry never saw rebuilds it from the meta file", async (t) => {
	const { registry, make, spec, clientOf, clients, sessionDir } = setup(t);
	const run = await registry.start(spec({ background: true }));
	clientOf(run).turn(user("Task: do it"), askCall("c1"), pauseResult("c1"));
	await metaEventually(sessionDir, run.id, (meta) => meta?.questions?.[0]?.id === "scope");

	const fresh = make();
	t.after(() => fresh.close());
	const restored = await fresh.resume(run.id, { answers: { scope: "Some" } });
	assert.equal(restored.agent, "worker");
	assert.equal(restored.state, "running");
	const respawned = clients.at(-1) as FakeClient;
	assert.ok(respawned.args.includes(run.id));
	assert.match(respawned.prompts[0], /<orchestrator-answers>\nscope: Some\n/);
});

test("pause detection reads only the current turn", async (t) => {
	const { registry, spec, clientOf, sessionDir } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(user("Task: do it"), askCall("c1"), pauseResult("c1"));
	assert.equal(run.state, "paused");
	assert.deepEqual(
		run.paused?.map((q) => q.id),
		["scope"],
	);
	await metaEventually(sessionDir, run.id, (meta) => meta?.questions?.length === 1);

	await registry.resume(run.id, { answers: { scope: "All" } });
	client.turn(user("<orchestrator-answers>"), reply("all done"));
	assert.equal(run.state, "done", "the earlier turn's pause marker must not count");
	assert.equal(run.paused, undefined);
	await metaEventually(sessionDir, run.id, (meta) => meta !== undefined && meta.questions === undefined);
});

test("an error stop reason fails the run", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec({ background: true }));
	clientOf(run).turn(user("Task: do it"), { ...reply(""), stopReason: "error", errorMessage: "rate limited" });
	assert.equal(run.state, "failed");
	assert.equal(run.errorMessage, "rate limited");
});

test("a non-zero exit while running fails the run with the stderr tail", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.stderr = "boom: out of memory\n";
	client.exit(137);
	await flush();
	assert.equal(run.state, "failed");
	assert.equal(run.exitCode, 137);
	assert.match(run.errorMessage ?? "", /out of memory/);
	assert.equal(run.client, undefined);
});

test("a child agent_start moves a done run back to running and clears delivered", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec());
	const waiting = registry.wait([run.id]);
	const client = clientOf(run);
	client.turn(user("Task: do it"), reply("first"));
	await waiting;
	assert.equal(run.delivered, true);

	client.emit({ type: "agent_start" });
	assert.equal(run.state, "running");
	assert.equal(run.delivered, false);
	assert.equal(run.turnStart, 2);
	client.emit({ type: "message_end", message: reply("second") });
	client.emit({ type: "agent_settled" });
	assert.equal(run.state, "done");
	assert.equal(run.delivered, false);
});

test("a seventh start queues and starts when a running slot frees", async (t) => {
	const { registry, spec, clientOf, clients, startMany } = setup(t);
	const runs = await startMany(MAX_RUNNING);
	const seventh = await registry.start(spec({ background: true, task: "t6" }));
	assert.equal(seventh.state, "queued");
	assert.equal(clients.length, MAX_RUNNING);
	assert.deepEqual(await registry.wait([seventh.id], 0), [seventh], "a queued run counts as active");

	clientOf(runs[0]).turn(reply("finished"));
	await flush();
	assert.equal(seventh.state, "running");
	assert.equal(clients.length, MAX_RUNNING + 1);
	assert.deepEqual(clients.at(-1)?.prompts, ["Task: t6"]);
});

test("a ninth live child retires the oldest done child", async (t) => {
	const { registry, spec, clientOf, clients, startMany } = setup(t, { mockTime: true });
	const runs = await startMany(MAX_LIVE);
	for (let i = 0; i < 3; i++) {
		t.mock.timers.tick(1_000);
		clientOf(runs[i]).turn(reply("finished"));
		await flush();
	}
	assert.equal(clients.length, MAX_LIVE);
	assert.ok(runs.every((run) => run.client), "every child is still alive");
	const oldest = clients[0];

	const ninth = await registry.start(spec({ background: true, task: "t8" }));
	assert.equal(ninth.state, "running");
	assert.equal(oldest.stopped, true);
	assert.equal(runs[0].client, undefined);
	assert.equal(runs[0].state, "done", "retiring keeps the run and its result");
	assert.ok(runs[1].client && runs[2].client);
});

test("a start is rejected whole when every live child is busy or paused", async (t) => {
	const { registry, spec, clientOf, startMany } = setup(t);
	const runs = await startMany(MAX_LIVE);
	for (let i = 0; i < 3; i++) {
		clientOf(runs[i]).turn(askCall(`c${i}`), pauseResult(`c${i}`));
		await flush();
	}
	assert.equal(runs.filter((run) => run.state === "paused").length, 3);
	const before = registry.list().length;
	await assert.rejects(registry.start(spec({ background: true })), /alive and none is finished/);
	assert.equal(registry.list().length, before);
});

test("a queued start past the live cap is rejected at start", async (t) => {
	const { registry, spec, clientOf, clients, startMany } = setup(t);
	const runs = await startMany(MAX_LIVE);
	for (let i = 0; i < MAX_LIVE - MAX_RUNNING; i++) {
		clientOf(runs[i]).turn(askCall(`c${i}`), pauseResult(`c${i}`));
		await flush();
	}
	assert.equal(registry.list().filter((run) => run.state === "running").length, MAX_RUNNING);
	const before = registry.list().length;
	await assert.rejects(registry.start(spec({ background: true })), /alive and none is finished/);
	assert.equal(registry.list().length, before);
	assert.equal(clients.length, MAX_LIVE);
});

test("queued starts count against the finished children they would retire", async (t) => {
	const { registry, spec, clientOf, startMany } = setup(t);
	const runs = await startMany(MAX_LIVE);
	clientOf(runs[0]).turn(reply("finished"));
	clientOf(runs[1]).turn(askCall("c1"), pauseResult("c1"));
	await flush();
	const running = registry.list().filter((run) => run.state === "running");
	assert.equal(running.length, MAX_RUNNING);
	const queued = await registry.start(spec({ background: true }));
	assert.equal(queued.state, "queued");
	await assert.rejects(registry.start(spec({ background: true })), /alive and none is finished/);
});

test("a done child retires after ten idle minutes", async (t) => {
	const { registry, spec, clientOf } = setup(t, { mockTime: true });
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(reply("finished"));
	t.mock.timers.tick(DONE_IDLE_MS - 1);
	assert.equal(run.client, client);
	t.mock.timers.tick(1);
	assert.equal(run.client, undefined);
	assert.equal(client.stopped, true);
	assert.equal(run.state, "done");
});

test("a paused child retires after thirty idle minutes", async (t) => {
	const { registry, spec, clientOf } = setup(t, { mockTime: true });
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(askCall("c1"), pauseResult("c1"));
	t.mock.timers.tick(DONE_IDLE_MS);
	assert.equal(run.client, client);
	t.mock.timers.tick(PAUSED_IDLE_MS - DONE_IDLE_MS - 1);
	assert.equal(run.client, client);
	t.mock.timers.tick(1);
	assert.equal(run.client, undefined);
	assert.equal(run.state, "paused");
});

test("send forwards to a running child and is rejected on a run that is not running", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	assert.equal(await registry.send(run.id, "look here", "steer"), "queued");
	assert.equal(await registry.send(run.id, "then this", "follow_up"), "queued");
	assert.deepEqual(client.steers, ["look here"]);
	assert.deepEqual(client.followUps, ["then this"]);
	client.turn(reply("finished"));
	await assert.rejects(registry.send(run.id, "more", "steer"), /done, not running\. Use resume/);
});

test("stop marks the run stopped, settles its waiters, and drops later events", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec());
	const client = clientOf(run);
	const waiting = registry.wait([run.id]);
	await registry.stop(run.id);
	assert.equal(client.stopped, true);
	assert.equal(run.state, "stopped");
	const [result] = await waiting;
	assert.equal(result.state, "stopped");
	assert.equal(run.delivered, true);

	client.turn(user("late"), reply("late"));
	assert.equal(run.state, "stopped");
	assert.equal(run.messages.length, 0);
});

test("stop on a finished run leaves its state, result, and delivery alone", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(user("Task: do it"), reply("finished"));
	const messages = [...run.messages];
	const seen = changes.length;
	await registry.stop(run.id, { delivered: true });
	assert.equal(run.state, "done");
	assert.equal(run.delivered, false);
	assert.deepEqual(run.messages, messages);
	assert.equal(run.client, client);
	assert.equal(client.stopped, false);
	assert.equal(changes.length, seen);
});

test("stop on a paused run stops it", async (t) => {
	const { registry, spec, clientOf } = setup(t);
	const run = await registry.start(spec({ background: true }));
	const client = clientOf(run);
	client.turn(askCall("c1"), pauseResult("c1"));
	await registry.stop(run.id);
	assert.equal(run.state, "stopped");
	assert.equal(client.stopped, true);
});

test("a foreground run revived by its child is posted by the courier when it settles again", async (t) => {
	const { registry, spec, clientOf } = setup(t, { mockTime: true });
	const sent: unknown[] = [];
	const dispose = createCourier(registry, { sendMessage: (message: unknown) => sent.push(message) } as never);
	t.after(dispose);
	const run = await registry.start(spec());
	const waiting = registry.wait([run.id]);
	const client = clientOf(run);
	client.turn(user("Task: do it"), reply("first"));
	await waiting;
	t.mock.timers.tick(COALESCE_MS);
	assert.equal(sent.length, 0, "the wait collected the first settle");

	assert.equal(run.background, false);
	client.turn(reply("second"));
	assert.equal(run.background, true, "a turn the child started itself has no waiting tool call");
	t.mock.timers.tick(COALESCE_MS);
	assert.equal(sent.length, 1);
	assert.equal(run.delivered, true);
});

test("stop with delivered emits the stopped run already delivered, and stop without leaves it for the courier", async (t) => {
	const { registry, spec, changes } = setup(t);
	const reported = await registry.start(spec({ background: true }));
	const unreported = await registry.start(spec({ background: true }));
	await registry.stop(reported.id, { delivered: true });
	await registry.stop(unreported.id);
	assert.ok(changes.some((c) => c.id === reported.id && c.state === "stopped" && c.delivered));
	assert.ok(changes.some((c) => c.id === unreported.id && c.state === "stopped" && !c.delivered));
});

test("markDelivered sets delivered once and emits the change", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t);
	const run = await registry.start(spec({ background: true }));
	clientOf(run).turn(reply("finished"));
	const before = changes.length;
	registry.markDelivered(run.id);
	registry.markDelivered(run.id);
	assert.equal(run.delivered, true);
	assert.equal(changes.length, before + 1);
	assert.deepEqual(changes.at(-1), { id: run.id, state: "done", delivered: true });
	assert.equal(registry.isClosed(), false);
	await registry.close();
	assert.equal(registry.isClosed(), true);
});

test("close stops every child and drops every later event, settle, and timer", async (t) => {
	const { registry, spec, clientOf, changes } = setup(t, { mockTime: true });
	const done = await registry.start(spec({ background: true }));
	const doneClient = clientOf(done);
	doneClient.turn(reply("finished"));
	const running = await registry.start(spec());
	const runningClient = clientOf(running);
	const waiting = registry.wait([running.id]);

	await registry.close();
	assert.equal(doneClient.stopped, true);
	assert.equal(runningClient.stopped, true);
	assert.equal(running.state, "stopped");
	assert.equal(done.state, "done");
	assert.equal((await waiting)[0].state, "stopped");

	const seen = changes.length;
	runningClient.turn(reply("late"));
	t.mock.timers.tick(PAUSED_IDLE_MS);
	assert.equal(running.messages.length, 0);
	assert.equal(changes.length, seen);
	await assert.rejects(registry.start(spec()), /closed/);
	await assert.rejects(registry.wait(), /closed/);
});
