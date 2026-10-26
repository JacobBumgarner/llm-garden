/**
 * The side agent's child process: one `pi --mode rpc` on the aside session,
 * with pi's default tools. Imports types only from pi packages.
 */

import * as fs from "node:fs";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	DelegateClient,
	type DelegateClientOptions,
	type DelegateExit,
	type DelegateModel,
	type PromptDisposition,
} from "../../shared/rpc.ts";
import { buildChildArgs, writePromptToTempFile } from "../../shared/spawn.ts";
import { ASIDE_SYSTEM_PROMPT } from "./prompt.ts";

/** The slice of `DelegateClient` the child uses. */
export interface AsideClient {
	readonly exited: Promise<DelegateExit>;
	readonly stderr: string;
	start(): Promise<void>;
	prompt(text: string): Promise<PromptDisposition>;
	abort(): Promise<void>;
	setSessionName(name: string): Promise<void>;
	getMessages(): Promise<AgentMessage[]>;
	getAvailableModels(): Promise<DelegateModel[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	onEvent(fn: (ev: JsonAgentSessionEvent) => void): () => void;
	stop(): Promise<void>;
}

export interface AsideChildOptions {
	/** The aside session id, such as `aside-{mainSessionId}`. */
	sessionId: string;
	sessionDir: string;
	cwd: string;
	/** The model as `provider/id`, snapshotted at start. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	/** The main session's name, used as the aside's display name. */
	name?: string;
	/** Defaults to a `DelegateClient`. */
	createClient?: (options: DelegateClientOptions) => AsideClient;
}

/** Own one side agent process and its prompt file. */
export class AsideChild {
	private readonly options: AsideChildOptions;
	private client?: AsideClient;
	private promptDir?: string;
	private currentName?: string;
	private starting?: Promise<void>;

	constructor(options: AsideChildOptions) {
		this.options = options;
		this.currentName = options.name;
	}

	/** The live client's exit promise, or undefined before start. */
	get exited(): Promise<DelegateExit> | undefined {
		return this.client?.exited;
	}

	/** The tail of the child's stderr. */
	get stderr(): string {
		return this.client?.stderr ?? "";
	}

	/** Write the prompt file, spawn the child, and wait until it answers. After a failed start or an exit, the next call launches again. */
	start(): Promise<void> {
		this.starting ??= this.launch().catch((err) => {
			this.teardown();
			throw err;
		});
		return this.starting;
	}

	/** Send a question and resolve to the child's disposition. */
	ask(text: string): Promise<PromptDisposition> {
		return this.live().prompt(text);
	}

	/** Abort the in-flight answer. */
	abort(): Promise<void> {
		return this.live().abort();
	}

	/** Rename the child session when the name differs from the current one. */
	async setSessionName(name: string): Promise<void> {
		if (name === this.currentName) return;
		await this.live().setSessionName(name);
		this.currentName = name;
	}

	getMessages(): Promise<AgentMessage[]> {
		return this.live().getMessages();
	}

	getAvailableModels(): Promise<DelegateModel[]> {
		return this.live().getAvailableModels();
	}

	setModel(provider: string, modelId: string): Promise<void> {
		return this.live().setModel(provider, modelId);
	}

	/** Subscribe to child events. Returns the unsubscribe function. */
	onEvent(fn: (ev: JsonAgentSessionEvent) => void): () => void {
		return this.live().onEvent(fn);
	}

	/** Stop the child and remove the prompt file. */
	async stop(): Promise<void> {
		const client = this.client;
		try {
			await client?.stop();
		} finally {
			this.teardown();
		}
	}

	private live(): AsideClient {
		if (!this.client) throw new Error("Aside child not started");
		return this.client;
	}

	private async launch(): Promise<void> {
		const { sessionId, sessionDir, cwd, model, thinkingLevel, name } = this.options;
		fs.mkdirSync(sessionDir, { recursive: true });
		const tmp = await writePromptToTempFile("aside", ASIDE_SYSTEM_PROMPT);
		this.promptDir = tmp.dir;
		const args = buildChildArgs({
			sessionDir,
			sessionId,
			label: name,
			model,
			thinkingLevel,
			systemPromptFile: tmp.filePath,
		});
		const create = this.options.createClient ?? ((opts) => new DelegateClient(opts));
		const client = create({ args, cwd });
		this.client = client;
		client.exited.then(() => {
			if (this.client === client) this.teardown();
		});
		await client.start();
	}

	private teardown(): void {
		this.client = undefined;
		this.starting = undefined;
		if (this.promptDir) fs.rmSync(this.promptDir, { recursive: true, force: true });
		this.promptDir = undefined;
	}
}
