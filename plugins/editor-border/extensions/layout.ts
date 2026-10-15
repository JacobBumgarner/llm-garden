/**
 * Layout of the editor's top border: the running-subagent badge at the left
 * end, the session name at the right end, the badge's column span for click
 * hit testing, and the reading of the `subagent:live` payload into a count and
 * a paused flag. Pure, so the layout runs without a terminal.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Border columns kept to the right of the name. */
export const TAIL = 2;
/** Border columns kept to the left of the badge. */
export const HEAD = 2;
/** Border columns kept between the badge, or the left edge without one, and the name. */
export const MIN_GAP = 6;
/** The space on each side of the name. */
const NAME_PAD = 2;

type Paint = (text: string) => string;

/** The columns a badge covers on the top border, `end` exclusive. */
export interface BadgeSpan {
	start: number;
	end: number;
}

/** The live-run summary the badge shows. */
export interface LiveBadge {
	count: number;
	/** True while any run waits for an answer. */
	paused: boolean;
}

/** Styles for the segments of the composed border. `warning` paints a badge with a paused run. */
export interface TopBorderPaints {
	badge: Paint;
	warning: Paint;
	name: Paint;
	border: Paint;
}

/** The composed border line and where the badge landed on it. */
export interface TopBorder {
	line: string;
	/** Undefined when the badge is not drawn. */
	badge: BadgeSpan | undefined;
}

const PLAIN: TopBorderPaints = {
	badge: (text) => text,
	warning: (text) => text,
	name: (text) => text,
	border: (text) => text,
};

/** Read a `subagent:live` payload into a count and a paused flag, tolerating malformed data. */
export function parseLive(data: unknown): LiveBadge {
	const { count, runs } = (data ?? {}) as { count?: unknown; runs?: unknown };
	const paused = Array.isArray(runs) && runs.some((run) => (run as { state?: unknown } | null)?.state === "paused");
	return { count: typeof count === "number" && count > 0 ? count : 0, paused };
}

/** Return the badge text for a count of live runs with a `?` while one is paused, or an empty string at zero. */
export function badgeText(count: number, paused = false): string {
	if (count <= 0) return "";
	return ` ${count} λ ${paused ? "? " : ""}`;
}

/** Pick the badge paint, `warning` while a run is paused. */
function badgePaint(live: LiveBadge, paints: TopBorderPaints): Paint {
	return live.paused ? paints.warning : paints.badge;
}

/** The columns the badge takes on a row, zero when dropped, and the columns left for the name text. */
interface Budget {
	badgeWidth: number;
	nameRoom: number;
}

/**
 * Split a row of `width` between the badge and the name. The badge keeps its
 * width when `HEAD`, the badge, and `TAIL` fit, and is dropped otherwise. The
 * name gets what remains after the head and badge when shown, `MIN_GAP`, the
 * name's own padding, and the tail.
 */
function budget(badge: string, width: number): Budget {
	const wanted = visibleWidth(badge);
	const badgeWidth = wanted > 0 && width >= HEAD + wanted + TAIL ? wanted : 0;
	const reserved = TAIL + MIN_GAP + NAME_PAD + (badgeWidth > 0 ? HEAD + badgeWidth : 0);
	return { badgeWidth, nameRoom: width - reserved };
}

/**
 * Compose the top border row as `HEAD` columns of `base`, the badge, border
 * fill from `base`, the session name, and `TAIL` border columns, and return
 * the line with the badge's span. `base` is the border line the editor drew.
 * The name truncates to the room left after the head, badge, `MIN_GAP`, and
 * tail, and is dropped when none is left. The badge is dropped when the head,
 * badge, and tail do not fit. Without a badge the row is border fill, the
 * name, and the tail. The badge takes the `warning` paint while `paused` is set.
 */
export function composeTopBorder(
	base: string,
	width: number,
	name: string | undefined,
	live: LiveBadge,
	paints: TopBorderPaints = PLAIN,
): TopBorder {
	const badge = badgeText(live.count, live.paused);
	const { badgeWidth, nameRoom } = budget(badge, width);
	const label = name && nameRoom >= 1 ? ` ${truncateToWidth(name, nameRoom, "…")} ` : "";
	if (badgeWidth === 0 && label === "") return { line: base, badge: undefined };

	const head = badgeWidth > 0 ? HEAD : 0;
	const fill = width - head - badgeWidth - visibleWidth(label) - TAIL;
	const line =
		truncateToWidth(base, head, "") +
		(badgeWidth > 0 ? badgePaint(live, paints)(badge) : "") +
		truncateToWidth(base, fill, "") +
		(label === "" ? "" : paints.name(label)) +
		paints.border("─".repeat(TAIL));
	return { line, badge: badgeWidth > 0 ? { start: HEAD, end: HEAD + badgeWidth } : undefined };
}

/** Report whether a point on the editor lands on the badge span of the top border row. */
export function hitsBadge(span: BadgeSpan | undefined, x: number, y: number): boolean {
	return span !== undefined && y === 0 && x >= span.start && x < span.end;
}
