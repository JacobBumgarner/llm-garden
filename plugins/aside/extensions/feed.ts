import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_RESULT_CAP = 300;
const ARG_CAP = 200;
const TRUNCATED_MARK = "... [truncated]";
const FALLBACK_NOTE = "[Note: the last feed position is not on this branch, so the whole branch is sent again.]";
const TRANSCRIPT_OPEN = "<main-transcript>";
const TRANSCRIPT_CLOSE = "</main-transcript>";

/** Drop the transcript block the extension prepends to a question. */
export function stripTranscript(text: string): string {
	if (!text.startsWith(TRANSCRIPT_OPEN)) return text;
	const end = text.indexOf(TRANSCRIPT_CLOSE);
	return end < 0 ? text : text.slice(end + TRANSCRIPT_CLOSE.length).replace(/^\s+/, "");
}

/** One session entry as the feed reads it. Fields the feed does not use are ignored. */
export interface FeedEntry {
	type: string;
	id: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export interface Feed {
	text: string;
	cursor: string | undefined;
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text) parts.push(text);
		}
	}
	return parts.join("\n");
}

function cut(value: string, max: number, mark = ""): string {
	return value.length > max ? value.slice(0, max) + mark : value;
}

const FULL_ARG_TOOLS = new Set(["write", "edit"]);

function isPathKey(key: string): boolean {
	return key === "path" || key === "file_path" || key.endsWith("Path") || key.endsWith("_path");
}

function renderToolCall(part: { name?: unknown; arguments?: unknown }): string {
	const args = part.arguments && typeof part.arguments === "object" ? (part.arguments as Record<string, unknown>) : {};
	const full = FULL_ARG_TOOLS.has(String(part.name));
	const rendered = Object.entries(args).map(([key, value]) => {
		const json = JSON.stringify(value) ?? "undefined";
		return `${key}=${full || isPathKey(key) ? json : cut(json, ARG_CAP, TRUNCATED_MARK)}`;
	});
	return `[Assistant tool calls]: ${String(part.name)}(${rendered.join(", ")})`;
}

/** Render one entry as text blocks, or an empty list when the feed skips it. */
function renderEntry(entry: FeedEntry): string[] {
	if (entry.type !== "message" || !entry.message) return [];
	const { role, content } = entry.message;
	if (role === "user") {
		const text = textParts(content);
		return text ? [`[User]: ${text}`] : [];
	}
	if (role === "assistant") {
		const blocks: string[] = [];
		if (typeof content === "string") {
			if (content) blocks.push(`[Assistant]: ${content}`);
		} else if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as { type?: string; text?: unknown; thinking?: unknown };
				if (p.type === "text" && typeof p.text === "string" && p.text) blocks.push(`[Assistant]: ${p.text}`);
				else if (p.type === "thinking" && typeof p.thinking === "string" && p.thinking) blocks.push(`[Assistant thinking]: ${p.thinking}`);
				else if (p.type === "toolCall") blocks.push(renderToolCall(part as { name?: unknown; arguments?: unknown }));
			}
		}
		return blocks;
	}
	if (role === "toolResult") {
		const text = textParts(content);
		if (!text) return [];
		return [`[Tool result]: ${cut(text, TOOL_RESULT_CAP, TRUNCATED_MARK)}`];
	}
	return [];
}

/** Find the first branch index to send after the cursor. `lost` is true when the cursor is not on the branch. */
function feedStart(branch: readonly FeedEntry[], cursor: string | undefined): { start: number; lost: boolean } {
	if (cursor === undefined) return { start: 0, lost: false };
	const index = branch.findIndex((entry) => entry.id === cursor);
	if (index >= 0) return { start: index + 1, lost: false };
	return { start: 0, lost: branch.length > 0 };
}

/**
 * Render the main session branch as text for the side agent.
 * With no cursor, or a cursor that is not on the branch, the whole branch is sent.
 * Otherwise only entries after the cursor are sent.
 */
export function buildFeed(branch: readonly FeedEntry[], cursor: string | undefined): Feed {
	const last = branch.length > 0 ? branch[branch.length - 1].id : cursor;
	const { start, lost } = feedStart(branch, cursor);

	const blocks: string[] = [];
	for (let i = start; i < branch.length; i++) blocks.push(...renderEntry(branch[i]));

	if (lost && blocks.length > 0) blocks.unshift(FALLBACK_NOTE);
	return { text: blocks.join("\n\n"), cursor: last };
}

/**
 * The sidecar for a main session: which aside session is current, how far the feed has gone in it,
 * and where the feed stood in each aside session switched away from, keyed by aside session id.
 */
export interface Meta {
	session?: string;
	cursor?: string;
	cursors?: Record<string, string>;
}

/** The sidecar after moving from aside session `current` to `next`: the current cursor is parked under `current`, and `next` picks up its parked cursor, if any. */
export function switchSession(meta: Meta, current: string, next: string): Meta {
	const cursors = { ...meta.cursors };
	if (meta.cursor) cursors[current] = meta.cursor;
	else delete cursors[current];
	const cursor = cursors[next];
	delete cursors[next];
	return { session: next, cursor, ...(Object.keys(cursors).length > 0 ? { cursors } : {}) };
}

function metaPath(dir: string, mainSessionId: string): string {
	return path.join(dir, `aside-${mainSessionId}.meta.json`);
}

/** The aside session id for a main session, counting from 1. The first is `aside-{id}`, later ones `aside-{id}-{n}`. */
export function asideSessionId(mainSessionId: string, n = 1): string {
	return n <= 1 ? `aside-${mainSessionId}` : `aside-${mainSessionId}-${n}`;
}

/** The number of an aside session id for a main session, or undefined when the id belongs to another main session or is malformed. */
export function asideSessionNumber(mainSessionId: string, id: string): number | undefined {
	const first = asideSessionId(mainSessionId);
	if (id === first) return 1;
	if (!id.startsWith(`${first}-`)) return undefined;
	const n = Number(id.slice(first.length + 1));
	return Number.isInteger(n) && n >= 2 ? n : undefined;
}

/** The aside session id after every id in `known`: one past the highest number, or `-2` when only malformed ids are known. */
export function nextSessionId(mainSessionId: string, known: Iterable<string>): string {
	let max = 1;
	for (const id of known) max = Math.max(max, asideSessionNumber(mainSessionId, id) ?? 1);
	return asideSessionId(mainSessionId, max + 1);
}

/** Read the sidecar for a main session. A missing or unreadable file reads as empty. */
export function readMeta(dir: string, mainSessionId: string): Meta {
	try {
		const parsed = JSON.parse(fs.readFileSync(metaPath(dir, mainSessionId), "utf-8")) as { session?: unknown; cursor?: unknown; cursors?: unknown };
		const cursors: Record<string, string> = {};
		if (parsed.cursors && typeof parsed.cursors === "object") {
			for (const [id, cursor] of Object.entries(parsed.cursors)) if (typeof cursor === "string") cursors[id] = cursor;
		}
		return {
			session: typeof parsed.session === "string" ? parsed.session : undefined,
			cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
			...(Object.keys(cursors).length > 0 ? { cursors } : {}),
		};
	} catch {
		return {};
	}
}

/** Save the sidecar for a main session next to the aside session files. */
export function writeMeta(dir: string, mainSessionId: string, meta: Meta): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(metaPath(dir, mainSessionId), JSON.stringify(meta), { encoding: "utf-8", mode: 0o600 });
}
