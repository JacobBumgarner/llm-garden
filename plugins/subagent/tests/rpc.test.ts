import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DelegateClient, START_DEADLINE_MS, STDERR_TAIL_CHARS, type DelegateChild } from "../extensions/rpc.ts";

const STDIN_END = "<end>";

/** A scripted child: records stdin writes and the stdin close in order, and pushes stdout on demand. */
class FakeChild extends EventEmitter {
	written: string[] = [];
	killed: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = {
		write: (chunk: string) => {
			this.written.push(chunk);
		},
		end: () => {
			this.written.push(STDIN_END);
		},
		on: () => {},
	};
	kill(signal?: string) {
		this.killed.push(signal ?? "SIGTERM");
	}
	push(chunk: string) {
		this.stdout.emit("data", Buffer.from(chunk));
	}
	reply(record: object) {
		this.push(`${JSON.stringify(record)}\n`);
	}
	records() {
		return this.written.filter((line) => line !== STDIN_END).map((line) => JSON.parse(line));
	}
	exit(code: number | null = 0, signal: string | null = null) {
		this.emit("exit", code, signal);
		this.emit("close", code, signal);
	}
	answerGetState() {
		this.reply({ type: "response", id: this.records()[0].id, command: "get_state", success: true, data: {} });
	}
}

function setup() {
	const child = new FakeChild();
	const spawned: { command: string; args: string[] }[] = [];
	const client = new DelegateClient({
		args: ["--no-session"],
		cwd: "/tmp",
		command: "pi-fake",
		spawn: (command, args) => {
			spawned.push({ command, args });
			return child as unknown as DelegateChild;
		},
	});
	return { child, client, spawned };
}

async function started() {
	const fixture = setup();
	const ready = fixture.client.start();
	fixture.child.answerGetState();
	await ready;
	return fixture;
}

function collect(client: DelegateClient): any[] {
	const events: any[] = [];
	client.onEvent((ev) => events.push(ev));
	return events;
}

test("start passes --mode rpc before the caller's args", async () => {
	const { spawned } = await started();
	assert.deepEqual(spawned, [{ command: "pi-fake", args: ["--mode", "rpc", "--no-session"] }]);
});

test("start sends get_state and resolves on its response", async () => {
	const { child, client } = setup();
	const ready = client.start();
	assert.equal(child.records()[0].type, "get_state");
	child.answerGetState();
	await ready;
});

test("a record split across two stdout chunks is delivered once", async () => {
	const { child, client } = await started();
	const events = collect(client);
	const line = JSON.stringify({ type: "agent_start" });
	child.push(line.slice(0, 7));
	assert.equal(events.length, 0);
	child.push(`${line.slice(7)}\n`);
	assert.deepEqual(events, [{ type: "agent_start" }]);
});

test("a U+2028 inside a JSON string does not split the record", async () => {
	const { child, client } = await started();
	const events = collect(client);
	child.push(`${JSON.stringify({ type: "message_end", text: "a\u2028b" })}\n`);
	assert.equal(events.length, 1);
	assert.equal(events[0].text, "a\u2028b");
});

test("malformed lines go to the stderr tail and never throw", async () => {
	const { child, client } = await started();
	child.push("not json\n");
	assert.match(client.stderr, /not json/);
});

test("the stderr tail is bounded", async () => {
	const { child, client } = await started();
	child.stderr.emit("data", Buffer.from("x".repeat(20_000)));
	assert.equal(client.stderr.length, STDERR_TAIL_CHARS);
});

test("responses resolve the pending command with the same id, in any order", async () => {
	const { child, client } = await started();
	const first = client.prompt("one");
	const second = client.steer("two");
	const [p, s] = child.records().slice(1);
	assert.equal(p.type, "prompt");
	assert.equal(s.type, "steer");
	child.reply({ type: "response", id: s.id, command: "steer", success: true, data: { disposition: "queued" } });
	assert.equal(await second, "queued");
	child.reply({ type: "response", id: p.id, command: "prompt", success: true, data: { disposition: "started" } });
	assert.equal(await first, "started");
});

test("a failed response rejects with the child's error", async () => {
	const { child, client } = await started();
	const result = client.followUp("x");
	child.reply({ type: "response", id: child.records()[1].id, command: "follow_up", success: false, error: "nope" });
	await assert.rejects(result, /nope/);
});

test("a non-response record with an id goes to listeners, not to pending commands", async () => {
	const { child, client } = await started();
	const events = collect(client);
	const result = client.prompt("x");
	const id = child.records()[1].id;
	child.reply({ type: "bash_execution_update", id });
	assert.equal(events.length, 1);
	child.reply({ type: "response", id, command: "prompt", success: true, data: { disposition: "started" } });
	assert.equal(await result, "started");
});

test("extension_ui_request is answered with a cancellation and not forwarded", async () => {
	const { child, client } = await started();
	const events = collect(client);
	child.reply({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run?", message: "m" });
	assert.deepEqual(child.records().at(-1), { type: "extension_ui_response", id: "ui-1", cancelled: true });
	assert.equal(events.length, 0);
});

test("start rejects after the start deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { child, client } = setup();
	const assertion = assert.rejects(client.start(), /get_state/);
	t.mock.timers.tick(START_DEADLINE_MS);
	await assertion;
	assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("start rejects when the child exits first", async () => {
	const { child, client } = setup();
	const ready = client.start();
	child.exit(1);
	await assert.rejects(ready, /exited/);
});

test("exit rejects every pending command and resolves exited", async () => {
	const { child, client } = await started();
	const a = client.prompt("a");
	const b = client.getMessages();
	child.exit(2);
	await assert.rejects(a, /exited/);
	await assert.rejects(b, /exited/);
	assert.deepEqual(await client.exited, { code: 2, signal: null });
	await assert.rejects(client.prompt("late"), /exited/);
});

test("stop sends clear_queue, then abort, then ends stdin, and resolves on exit", async () => {
	const { child, client } = await started();
	const stopped = client.stop();
	const sequence = child.written.slice(1).map((line) => (line === STDIN_END ? line : JSON.parse(line).type));
	assert.deepEqual(sequence, ["clear_queue", "abort", STDIN_END]);
	child.exit(0);
	await stopped;
});

test("stop escalates to SIGTERM at 5 s and SIGKILL at 10 s", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { child, client } = await started();
	const stopped = client.stop();
	t.mock.timers.tick(5_000);
	assert.deepEqual(child.killed, ["SIGTERM"]);
	t.mock.timers.tick(5_000);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
	child.exit(null, "SIGKILL");
	await stopped;
});

test("stop before start resolves without spawning", async () => {
	const { client, spawned } = setup();
	await client.stop();
	assert.equal(spawned.length, 0);
});
