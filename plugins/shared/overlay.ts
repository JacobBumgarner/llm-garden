/**
 * Open a component as an overlay and own everything around it: the rounded
 * frame with a painted title, mouse coordinates shifted into the frame, the
 * outside-click policy, hide and show around dialogs, and the refresh timer.
 * A panel draws only its text area and sees coordinates relative to it.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type OverlayHandle, type OverlayOptions, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { watchOutsideClicks } from "./outside-click.ts";

/** Columns the frame takes from the width: a border and a space on each side. */
const FRAME_COLUMNS = 4;
/** Columns left of the text area: the border and one space. */
const FRAME_LEFT = 2;
/** Rows above the text area: the top edge. */
const FRAME_TOP = 1;

/** What a panel can do to the overlay that holds it. */
export interface OverlayHost {
	close(): void;
	hide(): void;
	/** Show the overlay again and give it focus. */
	show(): void;
	isHidden(): boolean;
	/** Hide the overlay while `dialog` runs, then show it with focus. */
	suspend<R>(dialog: () => Promise<R>): Promise<R>;
	requestRender(): void;
}

/** What a panel offers beyond `Component`: focus, mouse input, and cleanup. */
export type Panel = Component & {
	dispose?(): void;
	focused?: boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

export interface OverlaySpec {
	options: OverlayOptions;
	/** The top edge's text, painted by the caller. Read on every render. */
	title: () => string;
	/** What a left press outside the overlay does: close it, hide it, or nothing. */
	outsideClick: "close" | "hide" | "none";
	/** Redraw every this many milliseconds, for panels that show live durations. */
	refreshMs?: number;
	/** Start watching for outside presses. Defaults to `watchOutsideClicks`. */
	watch?: typeof watchOutsideClicks;
	/** Build the panel. It draws inside the frame, so it gets the inner width. */
	build(host: OverlayHost, tui: TUI, theme: Theme): Panel;
}

/** Draw `inner` lines inside a rounded box. The title keeps the paint the caller gave it, and `border` paints the edges. */
export function boxLines(inner: string[], width: number, frame: { title: string; border: (text: string) => string }): string[] {
	const { border } = frame;
	const text = Math.max(width - FRAME_COLUMNS, 1);
	const title = truncateToWidth(frame.title, Math.max(width - 3, 0), "");
	const fill = Math.max(width - 3 - visibleWidth(title), 0);
	const top = border("╭─") + title + border("─".repeat(fill) + "╮");
	const rows = inner.map((line) => `${border("│")} ${truncateToWidth(line, text, "…", true)} ${border("│")}`);
	return [top, ...rows, border(`╰${"─".repeat(Math.max(width - 2, 0))}╯`)];
}

/** The component the overlay shows: a panel inside a frame. */
class Framed implements Component {
	private width = 0;
	private height = 0;
	private captured = false;
	private readonly refresh?: ReturnType<typeof setInterval>;
	private readonly panel: Panel;
	private readonly spec: OverlaySpec;
	private readonly theme: Theme;

	constructor(panel: Panel, spec: OverlaySpec, theme: Theme, tui: TUI) {
		this.panel = panel;
		this.spec = spec;
		this.theme = theme;
		if (spec.refreshMs) {
			this.refresh = setInterval(() => tui.requestRender(), spec.refreshMs);
			this.refresh.unref?.();
		}
	}

	get focused(): boolean {
		return this.panel.focused ?? false;
	}

	set focused(value: boolean) {
		if ("focused" in this.panel) this.panel.focused = value;
	}

	render(width: number): string[] {
		const lines = boxLines(this.panel.render(Math.max(width - FRAME_COLUMNS, 1)), width, {
			title: this.spec.title(),
			border: (text) => this.theme.fg("border", text),
		});
		this.width = width;
		this.height = lines.length;
		return lines;
	}

	handleInput(data: string): void {
		this.panel.handleInput?.(data);
	}

	/** Shift the event into the text area. A press on the frame is swallowed, except while a drag that began inside holds the mouse. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const onBorder = event.x === 0 || event.x === this.width - 1 || event.y === 0 || event.y === this.height - 1;
		if (onBorder && !this.captured) return { handled: true };
		const result = this.panel.handleMouse?.({ ...event, x: event.x - FRAME_LEFT, y: event.y - FRAME_TOP });
		this.captured = result?.capture === true;
		return result;
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	dispose(): void {
		if (this.refresh) clearInterval(this.refresh);
		this.panel.dispose?.();
	}
}

/** Open `spec` as an overlay and resolve with the value it closes with. The outside-click watch stops when the overlay closes. */
export async function openOverlay<T = void>(ui: Pick<ExtensionUIContext, "custom">, spec: OverlaySpec): Promise<T> {
	let handle: OverlayHandle | undefined;
	let tuiRef: TUI | undefined;
	let finish: ((result: T) => void) | undefined;
	let unwatch: (() => void) | undefined;
	const host: OverlayHost = {
		close: () => finish?.(undefined as T),
		hide: () => handle?.setHidden(true),
		show: () => {
			handle?.setHidden(false);
			handle?.focus();
		},
		isHidden: () => handle?.isHidden() ?? false,
		suspend: async (dialog) => {
			host.hide();
			try {
				return await dialog();
			} finally {
				host.show();
			}
		},
		requestRender: () => tuiRef?.requestRender(),
	};
	try {
		return await ui.custom<T>(
			(tui, theme, _keybindings, done) => {
				tuiRef = tui;
				finish = done;
				return new Framed(spec.build(host, tui, theme), spec, theme, tui);
			},
			{
				overlay: true,
				overlayOptions: spec.options,
				onHandle: (value) => {
					handle = value;
					if (spec.outsideClick === "none") return;
					const onOutside = spec.outsideClick === "close" ? host.close : host.hide;
					unwatch = (spec.watch ?? watchOutsideClicks)(() => value.getBounds(), onOutside);
				},
			},
		);
	} finally {
		unwatch?.();
		unwatch = undefined;
		handle = undefined;
		finish = undefined;
		tuiRef = undefined;
	}
}

/** Holds at most one open overlay for a plugin. */
export class OverlaySlot {
	private host: OverlayHost | undefined;
	private opening = false;

	/** The open overlay's host, if one is open. */
	get active(): OverlayHost | undefined {
		return this.host;
	}

	/** Open `spec` unless one is open. Resolves when the overlay closes, and the slot is clear by then. */
	async open(ui: Pick<ExtensionUIContext, "custom">, spec: OverlaySpec): Promise<void> {
		if (this.host || this.opening) return;
		this.opening = true;
		try {
			await openOverlay(ui, {
				...spec,
				build: (host, tui, theme) => {
					this.host = host;
					return spec.build(host, tui, theme);
				},
			});
		} finally {
			this.host = undefined;
			this.opening = false;
		}
	}

	close(): void {
		this.host?.close();
	}
}
