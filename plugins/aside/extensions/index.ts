/** The `aside` extension: a side panel hosting a second agent. */

import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { AsideChild } from "./child.ts";
import { watchOutsideClicks } from "../../shared/outside-click.ts";
import { modelAlias } from "../../shared/model-alias.ts";
import { buildFeed, type FeedEntry, type Meta, nextSessionId, readMeta, asideSessionId, writeMeta } from "./feed.ts";
import { OVERLAY_OPTIONS, type PanelBackend, type PanelEvent, type PanelListener, AsidePanel, TOGGLE_KEY } from "./panel.ts";

function sessionDir(): string {
	return process.env.PI_ASIDE_SESSION_DIR || path.join(getAgentDir(), "aside-sessions");
}

/** One aside: the side agent for one main session, and the panel over it. */
class Aside implements PanelBackend {
	readonly sessionId: string;
	handle?: OverlayHandle;
	/** Stops the outside-click watch on the raw input while the panel exists. */
	unwatch?: () => void;
	close?: () => void;
	private readonly pi: ExtensionAPI;
	private readonly dir = sessionDir();
	private readonly listeners = new Set<PanelListener>();
	private child?: AsideChild;
	private ctx: ExtensionContext;
	private meta?: Meta;
	private attached?: Promise<unknown>;
	private detach?: () => void;
	private snapshotModelId?: string;

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
		const id = this.snapshotModelId ?? this.ctx.model?.id;
		return id ? modelAlias(id) : "default model";
	}

	/** Stop the side agent and point the sidecar at a new session with no cursor. The old session file stays on disk. */
	async startNew(): Promise<void> {
		const next = nextSessionId(this.sessionId, this.currentSession());
		this.close?.();
		await this.stop();
		this.child = undefined;
		this.attached = undefined;
		this.snapshotModelId = undefined;
		this.meta = { session: next };
		writeMeta(this.dir, this.sessionId, this.meta);
	}

	async stop(): Promise<void> {
		this.detach?.();
		this.detach = undefined;
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
			const model = this.ctx.model ? `${this.ctx.model.provider}/${this.ctx.model.id}` : undefined;
			this.snapshotModelId = this.ctx.model?.id;
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

/** Hide a shown panel, or show a hidden one and bring it current, which counts as a panel open. */
async function toggleHidden(handle: OverlayHandle, t: Aside): Promise<void> {
	if (!handle.isHidden()) {
		handle.setHidden(true);
		return;
	}
	handle.setHidden(false);
	handle.focus();
	await t.syncName().catch(() => {});
}

/** Show the panel as an overlay and resolve when it closes. */
async function openPanel(ctx: ExtensionContext, t: Aside): Promise<void> {
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				t.close = () => done();
				return new AsidePanel({
					tui,
					theme,
					backend: t,
					model: t.modelLabel(),
					hide: () => t.handle?.setHidden(true),
				});
			},
			{
				overlay: true,
				overlayOptions: OVERLAY_OPTIONS,
				onHandle: (h) => {
					t.handle = h;
					t.unwatch = watchOutsideClicks(() => h.getBounds(), () => h.setHidden(true));
				},
			},
		);
	} finally {
		t.unwatch?.();
		t.unwatch = undefined;
		t.handle = undefined;
		t.close = undefined;
	}
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
		if (t.handle) await toggleHidden(t.handle, t);
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
		description: "Show or hide the aside panel, or `new` to start a fresh side agent",
		handler: (args, ctx) => (args.trim() === "new" ? startNew(ctx) : toggle(ctx)),
	});

	pi.on("session_start", (_event, ctx) => {
		current?.close?.();
		current = new Aside(pi, ctx, ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", async () => {
		const t = current;
		current = undefined;
		t?.close?.();
		await t?.stop();
	});
}
