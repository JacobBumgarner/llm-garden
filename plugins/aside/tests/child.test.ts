import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { DelegateClientOptions, DelegateExit, PromptDisposition } from "../../shared/rpc.ts";
import { AsideChild, type AsideClient } from "../extensions/child.ts";
import { ASIDE_SYSTEM_PROMPT } from "../extensions/prompt.ts";

class FakeClient implements AsideClient {
	readonly exited: Promise<DelegateExit>;
	exit!: (exit: DelegateExit) => void;
	stderr = "";
	calls: string[] = [];
	stopped = false;
	failStart = false;
	readonly options: DelegateClientOptions;

	constructor(options: DelegateClientOptions) {
		this.options = options;
		this.exited = new Promise((resolve) => {
			this.exit = resolve;
		});
	}
	async start() {
		if (this.failStart) throw new Error("no start");
	}
	async prompt(text: string): Promise<PromptDisposition> {
		this.calls.push(`prompt:${text}`);
		return "started";
	}
	async abort() {
		this.calls.push("abort");
	}
	async setSessionName(name: string) {
		this.calls.push(`name:${name}`);
	}
	async getMessages() {
		return [];
	}
	async getAvailableModels() {
		return [];
	}
	async setModel(provider: string, modelId: string) {
		this.calls.push(`model:${provider}/${modelId}`);
	}
	onEvent() {
		return () => {};
	}
	async stop() {
		this.stopped = true;
	}
}

function setup(extra: { name?: string; failStart?: boolean } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aside-test-"));
	const clients: FakeClient[] = [];
	const child = new AsideChild({
		sessionId: "aside-abc-123",
		sessionDir: path.join(dir, "sessions"),
		cwd: "/work",
		model: "anthropic/claude-x",
		thinkingLevel: "high",
		name: extra.name,
		createClient: (options) => {
			const client = new FakeClient(options);
			client.failStart = extra.failStart ?? false;
			clients.push(client);
			return client;
		},
	});
	return { dir, child, clients };
}

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

test("start builds args for the aside session, model, and thinking, with no tools flag", async () => {
	const { dir, child, clients } = setup({ name: "my main" });
	await child.start();
	const { args, cwd } = clients[0].options;
	assert.equal(cwd, "/work");
	assert.equal(flag(args, "--session-dir"), path.join(dir, "sessions"));
	assert.equal(flag(args, "--session-id"), "aside-abc-123");
	assert.equal(flag(args, "--model"), "anthropic/claude-x");
	assert.equal(flag(args, "--thinking"), "high");
	assert.ok(!args.includes("--tools"), "the child gets pi's default tools");
	assert.equal(flag(args, "--name"), "my main");
	assert.ok(!args.includes("--mode"), "the client adds --mode rpc itself");
	await child.stop();
});

test("the prompt file holds the system prompt and is removed on stop", async () => {
	const { child, clients } = setup();
	await child.start();
	const file = flag(clients[0].options.args, "--append-system-prompt")!;
	assert.equal(fs.readFileSync(file, "utf-8"), ASIDE_SYSTEM_PROMPT);
	await child.stop();
	assert.equal(clients[0].stopped, true);
	assert.equal(fs.existsSync(file), false);
});

test("the system prompt names the transcript block and the shared repo", () => {
	assert.match(ASIDE_SYSTEM_PROMPT, /<main-transcript>/);
	assert.match(ASIDE_SYSTEM_PROMPT, /Change files only when the developer asks/);
	assert.doesNotMatch(ASIDE_SYSTEM_PROMPT, /tutor/);
});

test("ask and abort reach the client", async () => {
	const { child, clients } = setup();
	await child.start();
	assert.equal(await child.ask("why?"), "started");
	await child.abort();
	assert.deepEqual(clients[0].calls, ["prompt:why?", "abort"]);
	await child.stop();
});

test("setSessionName skips an unchanged name and sends a new one", async () => {
	const { child, clients } = setup({ name: "same" });
	await child.start();
	await child.setSessionName("same");
	await child.setSessionName("other");
	await child.setSessionName("other");
	assert.deepEqual(clients[0].calls, ["name:other"]);
	await child.stop();
});

test("a failed start removes the prompt file and the next start retries", async () => {
	const { child, clients } = setup({ failStart: true });
	await assert.rejects(child.start(), /no start/);
	const file = flag(clients[0].options.args, "--append-system-prompt")!;
	assert.equal(fs.existsSync(file), false);
	await assert.rejects(child.start(), /no start/);
	assert.equal(clients.length, 2);
});

test("an exit on the child's own removes the prompt file and the next start launches a new child", async () => {
	const { child, clients } = setup();
	await child.start();
	const file = flag(clients[0].options.args, "--append-system-prompt")!;
	clients[0].exit({ code: 1, signal: null });
	await clients[0].exited;
	assert.equal(fs.existsSync(file), false);
	assert.throws(() => child.ask("x"), /not started/);
	await child.start();
	assert.equal(clients.length, 2);
	await child.stop();
});

test("ask before start rejects", () => {
	const { child } = setup();
	assert.throws(() => child.ask("x"), /not started/);
});
