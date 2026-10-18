/**
 * Minimal one-line footer: `▄ · tokens ⣿ · cost · elapsed · model thinking ···· repo (branch)`.
 *
 * The leading cell is focus-mode's breathing bar when focus is on; it is pinned to the first
 * column so it stays put while the other fields change width.
 *
 * The braille glyph after the token count is a stream-rate meter:
 * - idle: dim, all eight dots
 * - turn starts: drains in orange to a two-dot resting row, then holds
 * - tokens streaming: each column fills bottom-up with the output rate, the
 *   left column a smoothed average and the right the last second. The
 *   scale is relative to the model: four dots is the fastest smoothed rate
 *   that model has reached this session. Text,
 *   thinking, and tool-call arguments all count. Provider usage drives the
 *   rate when it advances mid-stream, chars/4 fills in between. Tool runs and
 *   pauses sit at the resting pair
 * - stalled mid-message for STALL_MS (8s): current frame freezes and blinks red/grey
 * - turn ends: the fill falls back to the resting pair, holds briefly, then
 *   refills in dim to eight dots
 *
 * The elapsed clock counts from the session's first entry, or from the most
 * recent /timer-reset, which persists as a custom session entry so it survives
 * resume. Shown as `12m`, `3h05m`, then `2d03h` once it passes a day.
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
	"claude-opus-5[1m]": "opus 5",
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

const REPO_PREFIX = /^lrl-xai-/;

// ---------------------------------------------------------------------------
// Formatting

function abbrev(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function elapsed(ms: number): string {
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
	return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

const TIMER_RESET = "footer-timer-reset";

/** Start of the elapsed clock: the latest timer reset on this branch, else the first entry. */
function sessionStart(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === TIMER_RESET) {
			const at = (e.data as { at?: number } | undefined)?.at;
			if (typeof at === "number") return at;
		}
	}
	const first = branch[0];
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
// Each column bottom-up: left 7 3 2 1, right 8 6 5 4.
const LEFT_COL = [0x40, 0x04, 0x02, 0x01];
const RIGHT_COL = [0x80, 0x20, 0x10, 0x08];
const column = (col: number[], n: number) => col.slice(0, n).reduce((a, b) => a | b, 0);
const columns = (left: number, right: number) => braille(column(LEFT_COL, left) | column(RIGHT_COL, right));
// Frames to hold the resting pair after the fill falls, before the refill begins.
const SETTLE_FRAMES = 3;

const REST_LEN = 1;
const FRAME_MS = 200;
const ACTIVE_MS = 5_000;
const STALL_MS = 8_000;
const BLINK_MS = 1_000;

// Providers deliver tokens in bursts a second or two apart. The short window feeds the right
// column so it reacts to each burst; the long one spans several and feeds the EMA for the left.
// Each model's ceiling is the peak smoothed rate seen this session, floored at MIN_CEILING so
// the first turns do not peg on noise.
const MIN_CEILING = 20;
const CHARS_PER_TOKEN = 4;
const COL_DOTS = 4;
const SNAP_WINDOW_MS = 1_000;
const RATE_WINDOW_MS = 3_000;
const RATE_SMOOTHING = 0.3;

/** Per-model peak smoothed rates for this session. */
class RateCeilings {
	private peaks: Record<string, number> = {};

	get(model: string): number {
		return Math.max(MIN_CEILING, this.peaks[model] ?? 0);
	}

	observe(model: string, rate: number): void {
		this.peaks[model] = Math.max(this.peaks[model] ?? 0, rate);
	}
}

type Phase = "idle" | "draining" | "waiting" | "flowing" | "falling" | "settling" | "refilling";

/** Tracks turn/stream lifecycle and renders the current glyph frame. */
class ActivityGlyph {
	private phase: Phase = "idle";
	private phaseFrame = 0;
	private avgLevel = REST_LEN;
	private nowLevel = REST_LEN;
	private rate = 0;
	private samples: { at: number; tokens: number }[] = [];
	// Cumulative output-token estimate for the current message and the last provider count seen.
	private estimate = 0;
	private providerOutput = 0;
	private streaming = false;
	private toolsRunning = 0;
	private lastActivity = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	private model = "";
	private readonly ceilings = new RateCeilings();

	constructor(private readonly onFrame: () => void) {}

	turnStart(model: string): void {
		this.model = model;
		this.avgLevel = REST_LEN;
		this.nowLevel = REST_LEN;
		this.rate = 0;
		this.samples = [];
		this.setPhase("draining");
		this.stopTimer();
		this.timer = setInterval(() => this.tick(), FRAME_MS);
	}

	messageStart(): void {
		this.streaming = true;
		this.estimate = 0;
		this.providerOutput = 0;
		this.touch();
	}

	/** Record a stream chunk: `chars` of new delta text and the provider's running output count, if any. */
	delta(chars: number, providerOutput: number): void {
		this.touch();
		const next =
			providerOutput > this.providerOutput ? providerOutput : this.estimate + chars / CHARS_PER_TOKEN;
		this.providerOutput = Math.max(this.providerOutput, providerOutput);
		const tokens = next - this.estimate;
		this.estimate = next;
		if (tokens > 0) this.samples.push({ at: this.lastActivity, tokens });
		if (this.phase !== "flowing") this.setPhase("flowing");
	}

	messageEnd(): void {
		this.streaming = false;
		this.estimate = 0;
		this.touch();
	}

	/** Output tokens of the message currently streaming, zero between messages. */
	inFlight(): number {
		return this.streaming ? Math.round(this.estimate) : 0;
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
		this.setPhase(Math.max(this.avgLevel, this.nowLevel) > REST_LEN ? "falling" : "settling");
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
				return live(columns(this.avgLevel, this.nowLevel));
		}
	}

	/** Map recent tokens/s onto the right column and its running average onto the left, against the model's ceiling. */
	private measure(): void {
		const now = Date.now();
		this.samples = this.samples.filter((s) => now - s.at <= RATE_WINDOW_MS);
		const perSecond = (windowMs: number) =>
			this.samples.filter((s) => now - s.at <= windowMs).reduce((sum, s) => sum + s.tokens, 0) * (1000 / windowMs);
		const instant = perSecond(SNAP_WINDOW_MS);
		this.rate += (perSecond(RATE_WINDOW_MS) - this.rate) * RATE_SMOOTHING;
		this.ceilings.observe(this.model, this.rate);
		const ceiling = this.ceilings.get(this.model);
		const level = (rate: number) => REST_LEN + Math.round((COL_DOTS - REST_LEN) * Math.min(1, rate / ceiling));
		this.avgLevel = level(this.rate);
		this.nowLevel = level(instant);
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
			this.measure();
		} else if (this.phase === "falling") {
			this.avgLevel = Math.max(REST_LEN, this.avgLevel - 1);
			this.nowLevel = Math.max(REST_LEN, this.nowLevel - 1);
			if (this.avgLevel <= REST_LEN && this.nowLevel <= REST_LEN) this.setPhase("settling");
		} else if (this.phase === "settling" && this.phaseFrame >= SETTLE_FRAMES) {
			this.setPhase("refilling");
		}
		this.onFrame();
	}
}

// ---------------------------------------------------------------------------
// Footer

// Set by the active footer so /timer-reset can restart its clock without a rebuild.
let resetTimer: ((at: number) => void) | undefined;

function install(pi: ExtensionAPI, ctx: ExtensionContext) {
	ctx.ui.setWorkingVisible(false);
	ctx.ui.setFooter((tui, theme, footerData) => {
		const render = () => tui.requestRender();
		const sep = theme.fg("dim", " · ");
		let startedAt = sessionStart(ctx);
		const glyph = new ActivityGlyph(render);
		resetTimer = (at) => {
			startedAt = at;
			render();
		};

		const isAssistant = (e: { message: { role: string } }) => e.message.role === "assistant";
		const unsubs = [
			footerData.onBranchChange(render),
			pi.on("model_select", render),
			pi.on("agent_start", () => glyph.turnStart(ctx.model?.id ?? "")),
			pi.on("message_start", (e) => isAssistant(e) && glyph.messageStart()),
			pi.on("message_update", (e) => {
				const ev = e.assistantMessageEvent;
				const chars = "delta" in ev ? ev.delta.length : 0;
				glyph.delta(chars, "partial" in ev ? (ev.partial.usage?.output ?? 0) : 0);
			}),
			pi.on("message_end", (e) => isAssistant(e) && glyph.messageEnd()),
			pi.on("tool_execution_start", () => glyph.toolStart()),
			pi.on("tool_execution_end", () => glyph.toolEnd()),
			pi.on("agent_end", () => glyph.turnEnd()),
		];
		const clock = setInterval(render, 60_000);

		return {
			dispose() {
				resetTimer = undefined;
				for (const unsub of unsubs) unsub();
				glyph.dispose();
				clearInterval(clock);
			},
			invalidate() {},
			render(width: number): string[] {
				const branch = footerData.getGitBranch();
				const branchText = branch ? ` (${branch})` : "";
				const repo = theme.fg("borderMuted", basename(ctx.cwd).replace(REPO_PREFIX, "") + branchText);

				const alias = ctx.model ? modelAlias(ctx.model.id) : "no model";
				const modelHex = modelColor(alias);
				const model = modelHex ? hex(modelHex, alias) : theme.fg("muted", alias);

				const level = pi.getThinkingLevel();
				const thinking = theme.fg(THINKING_COLOR[level] ?? "muted", level);

				const used = ctx.getContextUsage()?.tokens;
				const tokens = orange(used === undefined || used === null ? "?" : abbrev(used + glyph.inFlight()));
				const activity = glyph.render((s) => theme.fg("dim", s));
				const price = theme.fg("dim", `$${sessionCost(ctx).toFixed(2)}`);
				const age = theme.fg("dim", elapsed(Date.now() - startedAt));

				// The focus-mode breathing bar takes the first column so it never shifts with the other fields.
				const all = footerData.getExtensionStatuses();
				const breath = all.get("focus");
				const statuses = [...all.entries()].filter(([k]) => k !== "focus").map(([, v]) => v).join("  ");
				const left = `${breath ? ` ${breath}${sep}` : " "}${[`${tokens} ${activity}`, price, age, `${model} ${thinking}`].join(sep)}`;
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

	pi.registerCommand("timer-reset", {
		description: "Restart the footer's elapsed clock from now",
		handler: async (_args, ctx) => {
			const at = Date.now();
			pi.appendEntry(TIMER_RESET, { at });
			resetTimer?.(at);
			ctx.ui.notify("Footer timer reset", "info");
		},
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
