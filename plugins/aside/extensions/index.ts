/** The `aside` extension: a side panel hosting a second agent. */

import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { AsideChild } from "./child.ts";
import { type OverlayHost, OverlaySlot } from "../../shared/overlay.ts";
import { modelAlias } from "../../shared/model-alias.ts";
import {
	asideSessionId,
	asideSessionNumber,
	buildFeed,
	type FeedEntry,
	type Meta,
	nextSessionId,
	readMeta,
	stripTranscript,
	switchSession,
	writeMeta,
} from "./feed.ts";
import {
	OVERLAY_OPTIONS,
	type ModelChoice,
	type PanelBackend,
	type PanelEvent,
	type PanelListener,
	type SessionChoice,
	AsidePanel,
	TOGGLE_KEY,
} from "./panel.ts";

const FIRST_MESSAGE_CAP = 60;

function sessionDir(): string {
	return process.env.PI_ASIDE_SESSION_DIR || path.join(getAgentDir(), "aside-sessions");
}

/** One aside: the side agent for one main session, and the panel over it. */
class Aside implements PanelBackend {
	readonly sessionId: string;
	/** The open panel, if any. */
	readonly slot = new OverlaySlot();
	private readonly pi: ExtensionAPI;
	private readonly dir = sessionDir();
	private readonly listeners = new Set<PanelListener>();
	private child?: AsideChild;
	private ctx: ExtensionContext;
	private meta?: Meta;
	private attached?: Promise<unknown>;
	private detach?: () => void;
	/** The model the running side agent started with or switched to, as `provider/id`. */
	private activeModel?: string;
	/** The model picked with `/model`, kept for later side agent processes of this aside. */
	private chosenModel?: string;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext, sessionId: string) {
		this.pi = pi;
		this.ctx = ctx;
		this.sessionId = sessionId;
	}

	/** Point the aside at the context of the latest key press. */
	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	async start(): Promise<void> {
		const child = this.ensureChild();
		await child.start();
		if (child.exited !== this.attached) this.attach(child);
		await this.syncName();
	}

	/** Give the running side agent's session the main session's name, so the resume list stays readable after a rename. No-op without a name or a running child. */
	async syncName(): Promise<void> {
		const name = this.pi.getSessionName();
		if (name && this.child?.exited) await this.child.setSessionName(name);
	}

	async send(text: string): ReturnType<PanelBackend["send"]> {
		const meta = this.loadMeta();
		const feed = buildFeed(this.ctx.sessionManager.getBranch() as FeedEntry[], meta.cursor);
		const message = feed.text ? `<main-transcript>\n${feed.text}\n</main-transcript>\n\n${text}` : text;
		const disposition = await this.live().ask(message);
		if (feed.cursor) {
			meta.cursor = feed.cursor;
			writeMeta(this.dir, this.sessionId, meta);
		}
		return { disposition };
	}

	abort(): Promise<void> {
		return this.live().abort();
	}

	getMessages(): Promise<AgentMessage[]> {
		return this.live().getMessages();
	}

	subscribe(listener: PanelListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The status line's model text: the model the side agent started with, or main's model before it starts. */
	modelLabel(): string {
		const key = this.activeModel ?? this.mainModel();
		return key ? modelAlias(modelIdOf(key)) : "default model";
	}

	/** The running side agent's models, the active one marked. */
	async listModels(): Promise<ModelChoice[]> {
		const models = await this.live().getAvailableModels();
		return models.map((m) => {
			const key = `${m.provider}/${m.id}`;
			return { id: key, title: modelAlias(m.id), detail: m.name && m.name !== m.id ? `${m.provider} \u00b7 ${m.name}` : m.provider, current: key === this.activeModel };
		});
	}

	/** Switch the running side agent to the model `key`, as `provider/id`, and keep the choice for later processes. */
	async setModel(key: string): Promise<string> {
		const slash = key.indexOf("/");
		if (slash <= 0) throw new Error(`${key} is not provider/id`);
		await this.live().setModel(key.slice(0, slash), key.slice(slash + 1));
		this.activeModel = key;
		this.chosenModel = key;
		return modelAlias(modelIdOf(key));
	}

	private mainModel(): string | undefined {
		return this.ctx.model ? `${this.ctx.model.provider}/${this.ctx.model.id}` : undefined;
	}

	/** Stop the side agent and point the sidecar at a session numbered past every aside of this main session on disk. The old session file stays on disk. */
	async startNew(): Promise<void> {
		const known = (await this.listSessions()).map((s) => s.id);
		known.push(this.currentSession());
		await this.switchTo(nextSessionId(this.sessionId, known));
	}

	/** Stop the side agent and point the sidecar at an earlier aside session. No-op for the current one. */
	async resume(id: string): Promise<void> {
		if (asideSessionNumber(this.sessionId, id) === undefined) throw new Error(`${id} is not an aside of this session`);
		if (id !== this.currentSession()) await this.switchTo(id);
	}

	/** This main session's aside sessions on disk, newest first. */
	async listSessions(): Promise<SessionChoice[]> {
		const current = this.currentSession();
		const infos = await SessionManager.listAll(this.dir);
		return infos.flatMap((info) => {
			const n = asideSessionNumber(this.sessionId, info.id);
			if (n === undefined) return [];
			const opened = stripTranscript(info.firstMessage).split("\n", 1)[0] ?? "";
			const cut = opened.length > FIRST_MESSAGE_CAP ? `${opened.slice(0, FIRST_MESSAGE_CAP)}\u2026` : opened;
			return [{ id: info.id, title: `aside ${n}`, detail: `${formatWhen(info.modified)}  ${cut}`.trimEnd(), current: info.id === current }];
		});
	}

	/** Stop the side agent, park the feed cursor under the old session, and move the sidecar to `next`. Listeners hear `switched`. */
	private async switchTo(next: string): Promise<void> {
		const meta = switchSession(this.loadMeta(), this.currentSession(), next);
		await this.stop();
		this.child = undefined;
		this.activeModel = undefined;
		this.meta = meta;
		writeMeta(this.dir, this.sessionId, meta);
		for (const l of this.listeners) l.switched();
	}

	async stop(): Promise<void> {
		this.detach?.();
		this.detach = undefined;
		this.attached = undefined;
		await this.child?.stop();
	}

	/** Forward the running process's events and its exit to the panel listeners. Each relaunch gets a new exit promise, so this runs once per process. */
	private attach(child: AsideChild): void {
		this.detach?.();
		this.attached = child.exited;
		this.detach = child.onEvent((ev) => {
			for (const l of this.listeners) l.event(ev as PanelEvent);
		});
		void child.exited?.then((exit) => {
			if (this.attached !== child.exited) return;
			const detail = child.stderr.trim().split("\n").pop();
			const reason = `Side agent exited (code ${exit.code ?? exit.signal ?? "unknown"})${detail ? `: ${detail}` : ""}. The next question starts a new one.`;
			for (const l of this.listeners) l.exit(reason);
		});
	}

	private loadMeta(): Meta {
		this.meta ??= readMeta(this.dir, this.sessionId);
		return this.meta;
	}

	/** The aside session the sidecar names, or the first one when it names none. */
	private currentSession(): string {
		return this.loadMeta().session ?? asideSessionId(this.sessionId);
	}

	private live(): AsideChild {
		if (!this.child) throw new Error("Side agent not started");
		return this.child;
	}

	private ensureChild(): AsideChild {
		if (!this.child) {
			const model = this.chosenModel ?? this.mainModel();
			this.activeModel = model;
			this.child = new AsideChild({
				sessionId: this.currentSession(),
				sessionDir: this.dir,
				cwd: this.ctx.cwd,
				model,
				thinkingLevel: this.pi.getThinkingLevel(),
				name: this.pi.getSessionName(),
			});
		}
		return this.child;
	}
}

function modelIdOf(key: string): string {
	return key.slice(key.indexOf("/") + 1);
}

function formatWhen(date: Date): string {
	const sameDay = date.toDateString() === new Date().toDateString();
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return sameDay ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Hide a shown panel, or show a hidden one and bring it current, which counts as a panel open. */
async function toggleHidden(host: OverlayHost, t: Aside): Promise<void> {
	if (!host.isHidden()) {
		host.hide();
		return;
	}
	host.show();
	await t.syncName().catch(() => {});
}

/** Show the panel as an overlay and resolve when it closes. */
async function openPanel(ctx: ExtensionContext, t: Aside): Promise<void> {
	let paint: Theme | undefined;
	await t.slot.open(ctx.ui, {
		options: OVERLAY_OPTIONS,
		title: () => paint?.bold(" aside ") ?? " aside ",
		outsideClick: "hide",
		build: (host, tui, theme) => {
			paint = theme;
			return new AsidePanel({ tui, theme, backend: t, model: t.modelLabel(), cwd: ctx.cwd, hide: () => host.hide() });
		},
	});
}

export default function aside(pi: ExtensionAPI): void {
	let current: Aside | undefined;

	/** The aside for the current main session, bound to this context. Undefined outside the TUI, after a notice. */
	const asideFor = (ctx: ExtensionContext): Aside | undefined => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The aside panel needs the TUI.", "warning");
			return undefined;
		}
		const id = ctx.sessionManager.getSessionId();
		if (!current || current.sessionId !== id) current = new Aside(pi, ctx, id);
		current.bind(ctx);
		return current;
	};

	/** Open the panel if closed, show it if hidden, hide it if shown. */
	const toggle = async (ctx: ExtensionContext): Promise<void> => {
		const t = asideFor(ctx);
		if (!t) return;
		if (t.slot.active) await toggleHidden(t.slot.active, t);
		else await openPanel(ctx, t);
	};

	/** Stop the side agent and start the next question on a fresh aside session. */
	const startNew = async (ctx: ExtensionContext): Promise<void> => {
		const t = asideFor(ctx);
		if (!t) return;
		await t.startNew();
		ctx.ui.notify("new aside started", "info");
	};

	pi.registerShortcut(TOGGLE_KEY, { description: "Show or hide the aside panel", handler: (ctx) => void toggle(ctx) });
	pi.registerCommand("aside", {
		description: "Show or hide the aside panel, or `new` to start a fresh side agent. In the panel, `/new` and `/resume` do the same.",
		handler: (args, ctx) => (args.trim() === "new" ? startNew(ctx) : toggle(ctx)),
	});

	pi.on("session_start", (_event, ctx) => {
		current?.slot.close();
		current = new Aside(pi, ctx, ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", async () => {
		const t = current;
		current = undefined;
		t?.slot.close();
		await t?.stop();
	});
}
