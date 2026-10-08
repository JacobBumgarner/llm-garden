/**
 * Auto-name sessions.
 *
 * After the first exchange settles in an unnamed session, asks Claude Haiku
 * for a ~3-word lowercase-dash slug (e.g. `fix-store-retry`) from the user's
 * messages across the session (plus the first assistant reply), then sets it
 * as the session display name (shown in /resume).
 *
 * Usage:
 *   /rename                       - (re)generate a name from the session so far
 *   /rename delphi-cli            - set the name directly (already a slug)
 *   /rename building a delphi cli - Haiku turns the hint into a slug
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HAIKU_CANDIDATES: Array<[provider: string, id: string]> = [
	["anthropic", "claude-haiku-4-5"],
	["anthropic", "claude-haiku-4-5-20251001"],
	["lilly-code", "claude-haiku-4.5-20251001-v1"],
];

const MAX_MESSAGE_CHARS = 1200;
const MAX_CONTEXT_CHARS = 8000;
const MAX_ASSISTANT_CHARS = 1500;
const MAX_NAME_CHARS = 60;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => !!p && typeof p === "object" && p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Collect the user's messages across the session plus the first assistant
 * reply. When the user turns exceed the budget, keep the head and the tail so
 * both the opening task and any later pivot are visible.
 */
function sessionContext(ctx: ExtensionContext): { users: string[]; assistant: string } | undefined {
	const users: string[] = [];
	let assistant = "";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user") {
			const text = textOf(entry.message.content).trim();
			if (text) users.push(clip(text, MAX_MESSAGE_CHARS));
		} else if (role === "assistant" && !assistant && users.length > 0) {
			assistant = clip(textOf(entry.message.content).trim(), MAX_ASSISTANT_CHARS);
		}
	}
	if (users.length === 0) return undefined;

	let total = users.reduce((n, u) => n + u.length, 0);
	if (total > MAX_CONTEXT_CHARS) {
		const head = users.slice(0, Math.ceil(users.length / 3));
		const tail: string[] = [];
		total = head.reduce((n, u) => n + u.length, 0);
		for (let i = users.length - 1; i >= head.length; i--) {
			if (total + users[i].length > MAX_CONTEXT_CHARS) break;
			tail.unshift(users[i]);
			total += users[i].length;
		}
		return { users: [...head, "[…]", ...tail], assistant };
	}
	return { users, assistant };
}

function pickHaiku(ctx: ExtensionContext) {
	for (const [provider, id] of HAIKU_CANDIDATES) {
		const model = ctx.modelRegistry.find(provider, id);
		if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	}
	return undefined;
}

function cleanName(raw: string): string {
	const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_NAME_CHARS)
		.replace(/-+$/, "");
}

async function generateName(ctx: ExtensionContext, hint?: string): Promise<string | undefined> {
	const context = sessionContext(ctx);
	if (!context && !hint) return undefined;
	const model = pickHaiku(ctx);
	if (!model) return undefined;

	const lines = [
		"Write a concise, polished title for a coding-assistant session, formatted as a slug: 3-5 words, lowercase, joined by dashes, no quotes.",
		"Style: read like a well-edited headline or commit subject. Lead with a precise verb or the noun phrase for the deliverable. Use full, natural words -- no abbreviations, internal shorthand, file names, or filler like 'stuff', 'misc', 'help', 'question'. Prefer the specific over the generic (name the component or feature, not just 'bug' or 'code').",
		"Good: refine-session-rename-extension, stream-tool-results-to-ui, harden-store-retry-logic, design-delphi-cli.",
		"Weak: fix-bug, rename-ext, help-with-code, misc-cleanup.",
		"Reply with the slug only.",
	];
	if (hint) {
		lines.push(
			"",
			"The user described the session as follows. Base the slug primarily on this description; the transcript is only for disambiguation.",
			"<description>",
			hint,
			"</description>",
		);
	} else {
		lines.push("", "Name the session as a whole, not just the opening message. If the focus shifted, prefer the dominant or most recent thread.");
	}
	if (context) {
		lines.push("", "<user-messages>");
		context.users.forEach((u, i) => lines.push(`<message n="${i + 1}">`, u, "</message>"));
		lines.push("</user-messages>");
		if (context.assistant) lines.push("<first-assistant-reply>", context.assistant, "</first-assistant-reply>");
	}

	const response = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }], timestamp: Date.now() }] },
		{ cacheRetention: "none", sessionId: uuidv7() },
	);
	const name = cleanName(textOf(response.content));
	return name || undefined;
}

export default function (pi: ExtensionAPI) {
	let inFlight = false;

	const applyName = (ctx: ExtensionContext, name: string) => {
		pi.setSessionName(name);
		pi.events.emit("session:name-changed", { name });
		if (ctx.hasUI) ctx.ui.notify(`Session named: ${name}`, "info");
	};

	const nameSession = async (ctx: ExtensionContext, force: boolean, hint?: string) => {
		if (inFlight || (!force && pi.getSessionName())) return;
		inFlight = true;
		try {
			const name = await generateName(ctx, hint);
			if (!name) return;
			applyName(ctx, name);
		} catch (err) {
			if (ctx.hasUI) ctx.ui.notify(`rename failed: ${(err as Error).message}`, "warning");
		} finally {
			inFlight = false;
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		await nameSession(ctx, false);
	});

	pi.registerCommand("rename", {
		description: "Rename the session: /rename [slug | free-text description]; no args regenerates from the session",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input) return nameSession(ctx, true);
			if (SLUG_RE.test(input)) return applyName(ctx, input.slice(0, MAX_NAME_CHARS));
			await nameSession(ctx, true, input);
		},
	});
}
