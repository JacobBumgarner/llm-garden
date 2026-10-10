/**
 * Delegate client: owns one `pi --mode rpc` child. Frames JSONL on stdin and
 * stdout, correlates command responses by id, cancels every dialog the child
 * raises, fans session events out to listeners, keeps a bounded stderr tail,
 * and reports exit. Imports types only from pi packages.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getPiInvocation } from "./spawn.ts";

export type PromptDisposition = "handled" | "queued" | "started";
export type QueuedInputDisposition = "handled" | "queued";

export const START_DEADLINE_MS = 15_000;
export const TERM_AFTER_MS = 5_000;
export const KILL_AFTER_MS = 10_000;
export const STDERR_TAIL_CHARS = 8 * 1024;
const EXIT_GRACE_MS = 1_000;
const RPC_FLAGS = ["--mode", "rpc"];

export interface DelegateExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** The slice of a child process the client uses. A `ChildProcess` satisfies it. */
export interface DelegateChild {
	stdin: { write(chunk: string): unknown; end(): unknown; on?(event: "error", fn: (err: Error) => void): unknown } | null;
	stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
	stderr: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
	kill(signal?: NodeJS.Signals): unknown;
	on(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "close", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", fn: (err: Error) => void): unknown;
}

export type DelegateSpawn = (command: string, args: string[], options: { cwd: string }) => DelegateChild;

export interface DelegateClientOptions {
	/** Flags for the child. The client prepends `--mode rpc`. */
	args: string[];
	cwd: string;
	/** Defaults to `child_process.spawn` with stdio piped. */
	spawn?: DelegateSpawn;
	/** Defaults to the resolved pi binary. */
	command?: string;
}

interface Pending {
	resolve: (data: any) => void;
	reject: (err: Error) => void;
}

const defaultSpawn: DelegateSpawn = (command, args, options) =>
	nodeSpawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] }) as unknown as DelegateChild;

/** Drive one `pi --mode rpc` child through typed commands and session events. */
export class DelegateClient {
	readonly exited: Promise<DelegateExit>;
	private readonly options: DelegateClientOptions;
	private child?: DelegateChild;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(ev: JsonAgentSessionEvent) => void>();
	private stderrTail = "";
	private nextId = 1;
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private finished?: DelegateExit;
	private resolveExit!: (exit: DelegateExit) => void;
	private stopping?: Promise<void>;

	constructor(options: DelegateClientOptions) {
		this.options = options;
		this.exited = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/** The last 8192 characters of the child's stderr. */
	get stderr(): string {
		return this.stderrTail;
	}

	/** Spawn the child and resolve once it answers `get_state`. Rejects on exit or after fifteen seconds. */
	async start(): Promise<void> {
		if (this.child) throw new Error("Delegate client already started");
		const { command, args } = this.invocation();
		const child = (this.options.spawn ?? defaultSpawn)(command, args, { cwd: this.options.cwd });
		this.child = child;
		this.attach(child);
		await this.awaitReady(child);
	}

	prompt(text: string): Promise<PromptDisposition> {
		return this.command({ type: "prompt", message: text }).then((data) => data.disposition);
	}

	steer(text: string): Promise<QueuedInputDisposition> {
		return this.command({ type: "steer", message: text }).then((data) => data.disposition);
	}

	followUp(text: string): Promise<QueuedInputDisposition> {
		return this.command({ type: "follow_up", message: text }).then((data) => data.disposition);
	}

	async abort(): Promise<void> {
		await this.command({ type: "abort" });
	}

	getMessages(): Promise<AgentMessage[]> {
		return this.command({ type: "get_messages" }).then((data) => data.messages);
	}

	/** Subscribe to every record that is not a response or a dialog request. Returns the unsubscribe function. */
	onEvent(fn: (ev: JsonAgentSessionEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	/** Clear queued input, abort, close stdin, then escalate to SIGTERM after 5 s and SIGKILL after 10 s. */
	stop(): Promise<void> {
		this.stopping ??= this.runStop();
		return this.stopping;
	}

	/** Resolve the command and arguments, honouring an explicit `command` option. */
	private invocation(): { command: string; args: string[] } {
		const args = [...RPC_FLAGS, ...this.options.args];
		if (this.options.command) return { command: this.options.command, args };
		return getPiInvocation(args);
	}

	/** Wire the child's streams and lifecycle events to the client. */
	private attach(child: DelegateChild): void {
		child.stdout?.on("data", (chunk) => this.onStdout(chunk));
		child.stderr?.on("data", (chunk) => this.appendStderr(chunk.toString()));
		// A write after the child dies raises EPIPE here. The exit path already rejects pending commands.
		child.stdin?.on?.("error", () => {});
		child.on("error", (err) => {
			this.appendStderr(`${err.message}\n`);
			this.finish({ code: null, signal: null });
		});
		// `close` fires after stdout drains, so trailing responses still land. The fallback covers a grandchild
		// holding the pipes open, which would otherwise delay `close` indefinitely.
		child.on("exit", (code, signal) => {
			const timer = setTimeout(() => this.finish({ code, signal }), EXIT_GRACE_MS);
			timer.unref?.();
			this.exited.then(() => clearTimeout(timer));
		});
		child.on("close", (code, signal) => this.finish({ code, signal }));
	}

	/** Send `get_state` and wait for its response, killing the child at the deadline. */
	private async awaitReady(child: DelegateChild): Promise<void> {
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			deadline = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error(`pi child did not answer get_state within ${START_DEADLINE_MS / 1000}s`));
			}, START_DEADLINE_MS);
		});
		try {
			await Promise.race([this.command({ type: "get_state" }), timeout]);
		} finally {
			clearTimeout(deadline);
		}
	}

	/** Send the stop sequence and wait for exit, escalating signals on a timer. */
	private async runStop(): Promise<void> {
		const child = this.child;
		if (!child || this.finished) return;
		this.command({ type: "clear_queue" }).catch(() => {});
		this.command({ type: "abort" }).catch(() => {});
		try {
			child.stdin?.end();
		} catch {}
		const term = setTimeout(() => child.kill("SIGTERM"), TERM_AFTER_MS);
		const kill = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
		try {
			await this.exited;
		} finally {
			clearTimeout(term);
			clearTimeout(kill);
		}
	}

	/** Write a command with a fresh id and resolve with the `data` of its response. */
	private command(command: Record<string, unknown>): Promise<any> {
		if (!this.child) return Promise.reject(new Error("Delegate client not started"));
		if (this.finished) return Promise.reject(new Error("pi child has exited"));
		const id = `c${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (!this.write({ ...command, id })) {
				this.pending.delete(id);
				reject(new Error("Failed to write to pi child stdin"));
			}
		});
	}

	/** Write one JSONL record to stdin. Returns false when the write throws. */
	private write(record: Record<string, unknown>): boolean {
		try {
			this.child?.stdin?.write(`${JSON.stringify(record)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	/** Split stdout on `\n` only, so a U+2028 inside a JSON string stays in its record. */
	private onStdout(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line.length > 0) this.onLine(line);
			index = this.buffer.indexOf("\n");
		}
	}

	/** Route one record to its pending command, the dialog canceller, or the event listeners. */
	private onLine(line: string): void {
		const record = this.parse(line);
		if (!record) return;
		if (record.type === "response") this.settle(record);
		else if (record.type === "extension_ui_request") this.cancelDialog(record.id);
		else this.emit(record as JsonAgentSessionEvent);
	}

	/** Parse a stdout line into an object, sending anything else to the stderr tail. */
	private parse(line: string): Record<string, any> | undefined {
		try {
			const record = JSON.parse(line);
			if (record !== null && typeof record === "object") return record;
		} catch {}
		this.appendStderr(`[unparsable stdout] ${line}\n`);
		return undefined;
	}

	/** Resolve or reject the pending command whose id matches the response. */
	private settle(response: Record<string, any>): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		if (response.success === false) pending.reject(new Error(String(response.error ?? `${response.command} failed`)));
		else pending.resolve(response.data);
	}

	/** Answer a child dialog at once so it never blocks the run. */
	private cancelDialog(id: string): void {
		// `cancelled: true` is the variant of pi's RpcExtensionUIResponse that every dialog method accepts.
		this.write({ type: "extension_ui_response", id, cancelled: true });
	}

	/** Deliver an event to every listener. A throwing listener does not stop the others. */
	private emit(event: JsonAgentSessionEvent): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {}
		}
	}

	/** Append to the stderr tail, keeping only the last `STDERR_TAIL_CHARS`. */
	private appendStderr(text: string): void {
		this.stderrTail += text;
		if (this.stderrTail.length > STDERR_TAIL_CHARS) this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_CHARS);
	}

	/** Record the exit once, rejecting every pending command and resolving `exited`. */
	private finish(exit: DelegateExit): void {
		if (this.finished) return;
		this.finished = exit;
		const error = new Error(`pi child exited (code ${exit.code}, signal ${exit.signal})`);
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.resolveExit(exit);
	}
}
