/**
 * Breathing bar: a one-cell box-breathing pacer in the footer status area.
 *
 * Four ticks per side at 1.2s each: the bar rises on inhale, holds full, falls on exhale, holds
 * empty. Block Elements only, so every frame shares one baseline and cell width. Published as the
 * `breath` status, which the footer extension pins to the first column.
 *
 * `/breath` toggles the bar. `/breath <theme role | #rrggbb>` sets its color and turns it on.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "breath";

const INHALE = ["▂", "▄", "▆", "█"];
const HOLD_FULL = ["█", "█", "█", "█"];
const EXHALE = ["▆", "▄", "▂", "▁"];
const HOLD_EMPTY = ["▁", "▁", "▁", "▁"];
const FRAMES = [...INHALE, ...HOLD_FULL, ...EXHALE, ...HOLD_EMPTY];
const FRAME_MS = 1200;
const DEFAULT_COLOR = "#86B3AD";

/** How far the quiet hold ticks blend toward black; kept shallow so the colour doesn't fall to grey. */
const HOLD_DROP = 0.15;

export default function breath(pi: ExtensionAPI): void {
	let ui: ExtensionUIContext | undefined;
	let enabled = true;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;
	/** Bar color: a theme role name, or a `#rrggbb` hex rendered as a truecolor escape. */
	let color = DEFAULT_COLOR;

	function paint(text: string, drop = 0): string {
		if (color.startsWith("#")) {
			const n = parseInt(color.slice(1), 16);
			const c = (shift: number) => Math.round(((n >> shift) & 255) * (1 - drop));
			return `\x1b[38;2;${c(16)};${c(8)};${c(0)}m${text}\x1b[0m`;
		}
		return ui ? ui.theme.fg(color as Parameters<Theme["fg"]>[0], text) : text;
	}

	/** One frame: hold ticks alternate dropped and full so each one still counts. */
	function frameText(): string {
		const i = frame % FRAMES.length;
		const holding = (i >= 4 && i < 8) || i >= 12;
		return paint(FRAMES[i]!, holding && i % 2 === 0 ? HOLD_DROP : 0);
	}

	/** Step the bar on a timer, calling setStatus on the captured ui object so a stale ctx can't block it. */
	function start(): void {
		stop();
		frame = 0;
		ui?.setStatus(STATUS_KEY, frameText());
		timer = setInterval(() => {
			frame++;
			try {
				ui?.setStatus(STATUS_KEY, frameText());
			} catch {
				stop();
			}
		}, FRAME_MS);
	}

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function apply(): void {
		if (enabled) start();
		else {
			stop();
			ui?.setStatus(STATUS_KEY, undefined);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		apply();
	});
	// Fires on reload and session replacement; without it the old instance's timer keeps writing frames.
	pi.on("session_shutdown", stop);

	pi.registerCommand("breath", {
		description: "Toggle the breathing bar, or color it: /breath [theme role | #rrggbb]",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			const arg = (args ?? "").trim();
			if (arg) {
				color = arg;
				enabled = true;
			} else {
				enabled = !enabled;
			}
			apply();
			ctx.ui.notify(enabled ? `breath: ${color}` : "breath: off", "info");
		},
	});
}
