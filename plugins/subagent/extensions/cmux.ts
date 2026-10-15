/**
 * cmux progress reporter: mirrors the registry's live runs onto the cmux
 * workspace progress bar, so a custom sidebar can show that subagents are
 * running after the orchestrator's own turn has ended.
 *
 * Children run with cmux's pi hooks disabled (see `childEnv` in rpc.ts), and
 * cmux keeps one lifecycle per terminal per agent kind, so the orchestrator
 * reports on their behalf. Progress is independent of cmux's lifecycle state
 * machine: it never races the cmux-generated extension's own stop, and it
 * survives cmux regenerating that extension. A batch opens when the first run
 * goes live and closes when none is left; the bar reads `done/total agents`.
 */

import { spawn } from "node:child_process";
import { isActive } from "./registry.ts";
import type { Run } from "./types.ts";

export const COMMAND_TIMEOUT_MS = 5_000;

/** The registry surface the reporter reads. A `RunRegistry` satisfies it. */
export interface ProgressRegistry {
	on(event: "change", fn: (run: Run) => void): () => void;
	list(): Run[];
}

/** Run one cmux CLI invocation to completion. Failures are swallowed: progress is cosmetic. */
export type CmuxRunner = (args: string[]) => Promise<void>;

export interface ProgressOptions {
	env?: NodeJS.ProcessEnv;
	/** Defaults to spawning the `cmux` binary. */
	run?: CmuxRunner;
}

/** The set-progress or clear-progress call that reflects a batch. */
export type ProgressCommand = { kind: "set"; value: number; label: string } | { kind: "clear" };

/** Report whether this process should publish progress: inside a cmux workspace and not itself a hook-silenced child. */
export function progressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.CMUX_WORKSPACE_ID?.trim()) && env.CMUX_PI_HOOKS_DISABLED !== "1";
}

/** Build the CLI arguments for a progress command against one workspace. */
export function progressArgs(command: ProgressCommand, workspaceId: string): string[] {
	if (command.kind === "clear") return ["clear-progress", "--workspace", workspaceId];
	return ["set-progress", command.value.toFixed(2), "--label", command.label, "--workspace", workspaceId];
}

/** Describe a batch: `live` runs still active out of `total` in the batch. */
export function batchCommand(live: number, total: number): ProgressCommand {
	if (live === 0 || total === 0) return { kind: "clear" };
	const done = total - live;
	return { kind: "set", value: done / total, label: `${done}/${total} agents` };
}

function cmuxBinary(env: NodeJS.ProcessEnv): string {
	return env.CMUX_PI_CMUX_BIN?.trim() || env.CMUX_BUNDLED_CLI_PATH?.trim() || "cmux";
}

/** The default runner: spawn cmux with stdio discarded and kill it after the timeout. */
export function spawnCmux(env: NodeJS.ProcessEnv = process.env): CmuxRunner {
	return (args) =>
		new Promise<void>((resolve) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(cmuxBinary(env), args, { env, stdio: "ignore" });
			} catch {
				resolve();
				return;
			}
			const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
			const finish = () => {
				clearTimeout(timer);
				resolve();
			};
			child.once("error", finish);
			child.once("exit", finish);
		});
}

/**
 * Subscribe to the registry and keep the workspace progress bar current.
 * Commands are serialized and coalesced: only the latest batch state is sent
 * once the in-flight command returns. Returns the dispose function, which
 * clears the bar when a batch is open.
 */
export function createCmuxProgress(registry: ProgressRegistry, options: ProgressOptions = {}): () => void {
	const env = options.env ?? process.env;
	if (!progressEnabled(env)) return () => {};
	const workspaceId = (env.CMUX_WORKSPACE_ID as string).trim();
	const run = options.run ?? spawnCmux(env);

	const batch = new Set<string>();
	let published: ProgressCommand | undefined;
	let pending: ProgressCommand | undefined;
	let inFlight = false;
	let disposed = false;

	const sameCommand = (a: ProgressCommand | undefined, b: ProgressCommand) =>
		a !== undefined && (a.kind === "clear" ? b.kind === "clear" : b.kind === "set" && a.value === b.value && a.label === b.label);

	const flush = (): void => {
		if (inFlight || pending === undefined) return;
		const next = pending;
		pending = undefined;
		if (sameCommand(published, next)) return;
		inFlight = true;
		published = next;
		void run(progressArgs(next, workspaceId)).finally(() => {
			inFlight = false;
			flush();
		});
	};

	const publish = (command: ProgressCommand): void => {
		pending = command;
		flush();
	};

	const sync = (): void => {
		if (disposed) return;
		const live = registry.list().filter(isActive);
		for (const r of live) batch.add(r.id);
		if (live.length === 0) {
			if (batch.size === 0) return;
			batch.clear();
			publish({ kind: "clear" });
			return;
		}
		publish(batchCommand(live.length, batch.size));
	};

	const unsubscribe = registry.on("change", sync);
	sync();

	return () => {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		if (batch.size > 0 || (published !== undefined && published.kind === "set")) {
			batch.clear();
			publish({ kind: "clear" });
		}
	};
}
