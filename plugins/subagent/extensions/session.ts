/**
 * Session storage for subagent runs: directory resolution, the meta file beside
 * each session, and the retention sweep. Every function takes the directory as
 * a parameter so the module needs no pi runtime.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionMeta } from "./types.ts";

export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolve the session directory: `PI_SUBAGENT_SESSION_DIR` when set, else `<agentDir>/subagent-sessions`. */
export function resolveSessionDir(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SUBAGENT_SESSION_DIR ?? path.join(agentDir, "subagent-sessions");
}

/** Generate a fresh session id. */
export function newSessionId(): string {
	return `sub-${randomUUID().slice(0, 8)}`;
}

/** Build the path of a session's meta file. */
function metaPath(sessionDir: string, sessionId: string): string {
	return path.join(sessionDir, `${sessionId}.meta.json`);
}

/** Write the meta file for a session, creating the directory when needed. */
export async function writeMeta(sessionDir: string, sessionId: string, meta: SessionMeta): Promise<void> {
	await fs.promises.mkdir(sessionDir, { recursive: true });
	await fs.promises.writeFile(metaPath(sessionDir, sessionId), JSON.stringify(meta, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
}

/** Read the meta file for a session, or undefined when it is missing or unreadable. Unknown fields are ignored. */
export function readMeta(sessionDir: string, sessionId: string): SessionMeta | undefined {
	try {
		return JSON.parse(fs.readFileSync(metaPath(sessionDir, sessionId), "utf-8")) as SessionMeta;
	} catch {
		return undefined;
	}
}

/** Delete session and meta files older than the retention window. Errors are ignored. */
export async function sweepOldSessions(sessionDir: string, now: number = Date.now()): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(sessionDir);
	} catch {
		return;
	}
	const cutoff = now - SESSION_RETENTION_MS;
	for (const entry of entries) {
		const file = path.join(sessionDir, entry);
		try {
			const stat = await fs.promises.stat(file);
			if (stat.isFile() && stat.mtimeMs < cutoff) await fs.promises.unlink(file);
		} catch {
			/* ignore */
		}
	}
}
