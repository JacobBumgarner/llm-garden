/**
 * Minimal one-line footer: `tokens ⣿ · cost · elapsed · model thinking ···· repo (branch)`.
 *
 * The braille glyph after the token count is an activity indicator:
 * - idle: dim, all eight dots
 * - turn starts: drains in orange to a two-dot resting row, then holds
 * - tokens streaming or a tool running: a snake grows out of the resting pair
 *   and circles the cell; otherwise it holds its frame
 * - stalled mid-message for STALL_MS: current frame freezes and blinks red/grey
 * - turn ends: the snake unwinds back to the resting pair, holds briefly, then
 *   refills in dim to eight dots
 *
 * Replaces pi's default footer and hides the built-in "Working" row on session
 * start, since the glyph covers that role. Toggle back with /footer.
 */

import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Colors and labels

const RESET = "\x1b[0m";
const orange = (s: string) => `\x1b[38;5;173m${s}${RESET}`;
const red = (s: string) => `\x1b[1;38;5;196m${s}${RESET}`;
const grey = (s: string) => `\x1b[38;5;243m${s}${RESET}`;

function hex(color: string, s: string): string {
	const n = parseInt(color.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}${RESET}`;
}

const THINKING_COLOR: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

// ColorBrewer Spectral, with yellow and the fable red softened.
const MODEL_COLOR: Record<string, string> = {
	fable: "#E0606E",
	opus: "#FC8D59",
	sonnet: "#2A9DF4",
	glm: "#99D594",
	qwen3: "#8575CC",
	haiku: "#FEE08B",
};

const MODEL_ALIAS: Record<string, string> = {
	"claude-fable-5-1": "fable 5.1",
	"claude-opus-5-5": "opus 5.5",
	"claude-sonnet-5-5": "sonnet 5.5",
	"claude-opus-4.8[1m]": "opus 4.8",
	"claude-sonnet-5[1m]": "sonnet 5",
	"claude-lillypod-glm[1m]": "glm",
	"qwen3-8-27b-fp8": "qwen3 27b",
	"claude-haiku-4.5-20251001-v1": "haiku 4.5",
};

function modelAlias(id: string): string {
	return (
		MODEL_ALIAS[id] ??
		id
			.replace(/^claude-/, "")
			.replace(/\[1m\]$/, "")
			.replace(/-(\d+)-(\d+)/, " $1.$2")
	);
}

const modelColor = (alias: string) => MODEL_COLOR[alias.split(" ")[0]];

const BRANCH_COLOR: Record<string, string> = {
	feat: "#A3BE8C",
	fix: "#BF616A",
	refactor: "#88C0D0",
	maint: "#81A1C1",
	docs: "#D8DEE9",
	test: "#EBCB8B",
	junk: "#4C566A",
};

function branchColor(branch: string): string | undefined {
	return branch.includes("/") ? BRANCH_COLOR[branch.split("/")[0]] : undefined;
}

const REPO_PREFIX = /^lrl-xai-/;

// ---------------------------------------------------------------------------
// Formatting

function abbrev(n: number): string {
	if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function elapsed(ms: number): string {
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function sessionStart(ctx: ExtensionContext): number {
	const first = ctx.sessionManager.getBranch()[0];
	const t = first ? Date.parse(first.timestamp) : NaN;
	return Number.isNaN(t) ? Date.now() : t;
}

function sessionCost(ctx: ExtensionContext): number {
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			cost += (e.message as AssistantMessage).usage?.cost?.total ?? 0;
		}
	}
	return cost;
}

// ---------------------------------------------------------------------------
// Activity glyph

// Braille dot bits in bottom-up boustrophedon order (l r r l l r r l): 7 8 6 3 2 5 4 1.
const DOT_ORDER = [0x40, 0x80, 0x20, 0x04, 0x02, 0x10, 0x08, 0x01];
const braille = (bits: number) => String.fromCharCode(0x2800 | bits);
const dots = (n: number) => braille(DOT_ORDER.slice(0, n).reduce((a, b) => a | b, 0));

const FULL = dots(8);
const REST = dots(2);
// Top-down boustrophedon continuing from the fill's end (r l l r r l): remove 4 1 2 5 6 3.
const DRAIN_ORDER = [0x08, 0x01, 0x02, 0x10, 0x20, 0x04];
const DRAIN = DRAIN_ORDER.map((_, i) => braille(DRAIN_ORDER.slice(0, i + 1).reduce((a, b) => a & ~b, 0xff)));
const REFILL = [2, 3, 4, 5, 6, 7, 8].map(dots);
// Frames to hold the resting pair after unwinding, before the refill begins.
const SETTLE_FRAMES = 3;
// Braille dots around the cell perimeter, counter-clockwise from bottom-left: 7 3 2 1 4 5 6 8.
const RING = [0x40, 0x04, 0x02, 0x01, 0x08, 0x10, 0x20, 0x80];
const snake = (head: number, len: number) =>
	braille(Array.from({ length: len }, (_, i) => RING[(((head - i) % 8) + 8) % 8]).reduce((a, b) => a | b, 0));

const SNAKE_LEN = 6;
const REST_LEN = 2;

const FRAME_MS = 200;
const ACTIVE_MS = 5_000;
const STALL_MS = 5_000;
const BLINK_MS = 1_000;

type Phase = "idle" | "draining" | "waiting" | "flowing" | "unwinding" | "settling" | "refilling";

/** Tracks turn/stream lifecycle and renders the current glyph frame. */
class ActivityGlyph {
	private phase: Phase = "idle";
	private phaseFrame = 0;
	// Snake head index into RING and body length; head 0 / len 2 is the resting pair.
	private head = 0;
	private len = REST_LEN;
	private unwindSteps = 0;
	private streaming = false;
	private toolsRunning = 0;
	private lastActivity = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(private readonly onFrame: () => void) {}

	turnStart(): void {
		this.head = 0;
		this.len = REST_LEN;
		this.setPhase("draining");
		this.stopTimer();
		this.timer = setInterval(() => this.tick(), FRAME_MS);
	}

	messageStart(): void {
		this.streaming = true;
		this.touch();
	}

	delta(): void {
		this.touch();
		if (this.phase !== "flowing") this.setPhase("flowing");
	}

	messageEnd(): void {
		this.streaming = false;
		this.touch();
	}

	toolStart(): void {
		this.toolsRunning++;
		this.touch();
		if (this.phase !== "flowing") this.setPhase("flowing");
	}

	toolEnd(): void {
		this.toolsRunning = Math.max(0, this.toolsRunning - 1);
		this.touch();
	}

	turnEnd(): void {
		this.streaming = false;
		this.toolsRunning = 0;
		if (this.atRest()) {
			this.setPhase("settling");
			return;
		}
		let steps = (RING.length - this.head) % RING.length;
		if (steps < this.len - REST_LEN) steps += RING.length;
		this.unwindSteps = steps;
		this.setPhase("unwinding");
	}

	dispose(): void {
		this.stopTimer();
	}

	render(dim: (s: string) => string): string {
		if (this.phase === "idle") return dim(FULL);
		const stalled = this.streaming && Date.now() - this.lastActivity > STALL_MS;
		const blinkOn = Math.floor(Date.now() / BLINK_MS) % 2 === 0;
		const live = stalled ? (blinkOn ? red : grey) : orange;
		switch (this.phase) {
			case "draining":
				return orange(DRAIN[Math.min(this.phaseFrame, DRAIN.length - 1)]);
			case "refilling":
				return dim(REFILL[Math.min(this.phaseFrame, REFILL.length - 1)]);
			case "waiting":
			case "settling":
				return live(REST);
			default:
				return live(snake(this.head, this.len));
		}
	}

	private atRest(): boolean {
		return this.head % RING.length === 0 && this.len === REST_LEN;
	}

	/** Advance the head and lengthen the body toward SNAKE_LEN. */
	private grow(): void {
		this.head = (this.head + 1) % RING.length;
		this.len = Math.min(SNAKE_LEN, this.len + 1);
	}

	/** Advance the head and shrink the body so it reaches REST_LEN exactly as the budgeted steps run out. */
	private unwind(): void {
		this.head = (this.head + 1) % RING.length;
		this.unwindSteps--;
		if (this.len - REST_LEN > this.unwindSteps) this.len--;
	}

	private touch(): void {
		this.lastActivity = Date.now();
	}

	private alive(): boolean {
		return this.toolsRunning > 0 || Date.now() - this.lastActivity < ACTIVE_MS;
	}

	private setPhase(next: Phase): void {
		this.phase = next;
		this.phaseFrame = 0;
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private tick(): void {
		this.phaseFrame++;
		if (this.phase === "draining" && this.phaseFrame >= DRAIN.length) {
			this.setPhase("waiting");
		} else if (this.phase === "refilling" && this.phaseFrame >= REFILL.length) {
			this.setPhase("idle");
			this.stopTimer();
		} else if (this.phase === "flowing" && this.alive()) {
			this.grow();
		} else if (this.phase === "unwinding") {
			this.unwind();
			if (this.unwindSteps <= 0) this.setPhase("settling");
		} else if (this.phase === "settling" && this.phaseFrame >= SETTLE_FRAMES) {
			this.setPhase("refilling");
		}
		this.onFrame();
	}
}

// ---------------------------------------------------------------------------
// Footer

function install(pi: ExtensionAPI, ctx: ExtensionContext) {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setFooter((tui, theme, footerData) => {
		const render = () => tui.requestRender();
		const sep = theme.fg("dim", " · ");
		const startedAt = sessionStart(ctx);
		const glyph = new ActivityGlyph(render);

		const isAssistant = (e: { message: { role: string } }) => e.message.role === "assistant";
		const unsubs = [
			footerData.onBranchChange(render),
			pi.on("model_select", render),
			pi.on("agent_start", () => glyph.turnStart()),
			pi.on("message_start", (e) => isAssistant(e) && glyph.messageStart()),
			pi.on("message_update", () => glyph.delta()),
			pi.on("message_end", (e) => isAssistant(e) && glyph.messageEnd()),
			pi.on("tool_execution_start", () => glyph.toolStart()),
			pi.on("tool_execution_end", () => glyph.toolEnd()),
			pi.on("agent_end", () => glyph.turnEnd()),
		];
		const clock = setInterval(render, 60_000);

		return {
			dispose() {
				for (const unsub of unsubs) unsub();
				glyph.dispose();
				clearInterval(clock);
			},
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch();
				const branchHex = branch ? branchColor(branch) : undefined;
				const branchText = branch ? ` (${branch})` : "";
				const repo =
					theme.fg("accent", basename(ctx.cwd).replace(REPO_PREFIX, "")) +
					(branchHex ? hex(branchHex, branchText) : theme.fg("muted", branchText));

				const alias = ctx.model ? modelAlias(ctx.model.id) : "no model";
				const modelHex = modelColor(alias);
				const model = modelHex ? hex(modelHex, alias) : theme.fg("muted", alias);

				const level = pi.getThinkingLevel();
				const thinking = theme.fg(THINKING_COLOR[level] ?? "muted", level);

				const used = ctx.getContextUsage()?.tokens;
				const tokens = orange(used === undefined ? "?" : abbrev(used));
				const activity = glyph.render((s) => theme.fg("dim", s));
				const price = theme.fg("dim", `$${sessionCost(ctx).toFixed(2)}`);
				const age = theme.fg("dim", elapsed(Date.now() - startedAt));

				const left = ` ${[`${tokens} ${activity}`, price, age, `${model} ${thinking}`].join(sep)}`;
				const statuses = [...footerData.getExtensionStatuses().values()].join("  ");
				const right = `${statuses ? `${statuses}  ` : ""}${repo} `;

				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
				return [truncateToWidth(left + pad + right, width)];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		if (enabled) install(pi, ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle between minimal and default footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(pi, ctx);
				ctx.ui.notify("Minimal footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.setWorkingVisible(true);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
