import { matchesKey } from "@earendil-works/pi-tui";

/** Lines a wheel notch scrolls. */
export const WHEEL_LINES = 3;

/** Scroll offset clamped to the body, or pinned to the end. */
export function viewportTop(bodyHeight: number, viewportHeight: number, top: number, pinned: boolean): number {
	const max = Math.max(0, bodyHeight - viewportHeight);
	return pinned ? max : Math.min(Math.max(0, top), max);
}

/** A scroll position over a body of lines, either pinned to the end or free. */
export class Viewport {
	top = 0;
	pinned = true;

	/** Clamp `top` to the body and return it. Recomputes `pinned` from where `top` landed. */
	layout(bodyHeight: number, viewportHeight: number): number {
		this.top = viewportTop(bodyHeight, viewportHeight, this.top, this.pinned);
		this.pinned = this.top >= bodyHeight - viewportHeight;
		return this.top;
	}

	scrollBy(lines: number): void {
		this.top += lines;
		this.pinned = false;
	}

	toTop(): void {
		this.top = 0;
		this.pinned = false;
	}

	toEnd(): void {
		this.pinned = true;
	}

	/** Scroll by `WHEEL_LINES` in the direction of `delta`. */
	wheel(delta: number): void {
		this.scrollBy(Math.sign(delta) * WHEEL_LINES);
	}

	/** Scroll for up, down, pageUp, pageDown, home, or end. Returns false for any other key. */
	handleKey(data: string, pageSize: number): boolean {
		if (matchesKey(data, "up")) this.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-pageSize);
		else if (matchesKey(data, "pageDown")) this.scrollBy(pageSize);
		else if (matchesKey(data, "home")) this.toTop();
		else if (matchesKey(data, "end")) this.toEnd();
		else return false;
		return true;
	}
}
