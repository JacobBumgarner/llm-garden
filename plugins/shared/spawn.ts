/**
 * Child process setup shared by plugins that run a child `pi`: binary
 * resolution, the system prompt temp file, and the argument list.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Write a system prompt to a private temp file named after `name`. The caller removes the file and its directory. */
export async function writePromptToTempFile(
	name: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-child-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/** Resolve the command that launches this same pi, falling back to `pi` on PATH. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export interface ChildArgsOptions {
	sessionDir: string;
	sessionId: string;
	/** The session display name. */
	label?: string;
	/** The model to run, as `provider/id`. Omitted means the child's own default. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	systemPromptFile: string;
}

/** Build the child's session, model, thinking, tool, and system-prompt flags. The mode flag and the task prompt are the caller's. */
export function buildChildArgs(options: ChildArgsOptions): string[] {
	const args = ["--session-dir", options.sessionDir, "--session-id", options.sessionId];
	if (options.label) args.push("--name", options.label);
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	args.push("--append-system-prompt", options.systemPromptFile);
	return args;
}
