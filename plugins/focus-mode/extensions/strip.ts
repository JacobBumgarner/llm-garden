/**
 * Pure layout for a tool strip: the expansion body and the status color name.
 */

import type { ToolItem } from "./types.ts";

export const MAX_RESULT_LINES = 20;
/** Durations under this are not worth a suffix. */
const DURATION_MIN_MS = 2000;

/** Foreground role for the strip's status glyph. */
export type StripColor = "muted" | "error" | "success";

/** Pending until a final result arrives, then error or success. */
export function stripColor(item: ToolItem): StripColor {
	if (!item.result || item.result.partial) return "muted";
	return item.result.isError ? "error" : "success";
}

/**
 * The edit tool's rendered diff from `details.diff`, one line per entry, or undefined when the result
 * has not arrived or carries no diff. Each line starts with `+`, `-`, or a space marker.
 */
export function editDiffLines(item: ToolItem): string[] | undefined {
	if (item.name !== "edit" || !item.result || item.result.partial) return undefined;
	const details = item.result.details;
	const diff = details && typeof details === "object" ? (details as { diff?: unknown }).diff : undefined;
	if (typeof diff !== "string" || diff === "") return undefined;
	return diff.split("\n");
}

/** Each argument as `key: value`, then a blank line and the result text capped at MAX_RESULT_LINES. */
export function expansionLines(item: ToolItem): string[] {
	const args = Object.entries(item.args).map(
		([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
	);
	if (!item.result) return args;
	const result = item.result.text === "" ? [] : item.result.text.split("\n");
	const shown = result.slice(0, MAX_RESULT_LINES);
	const hidden = result.length - shown.length;
	if (hidden > 0) shown.push(`… ${hidden} more lines`);
	return [...args, "", ...shown];
}

/** Join the text parts of a tool result's content blocks. */
export function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** `4s` / `1m 05s`, or undefined when unknown or too short to matter. */
export function durationLabel(ms: number | undefined): string | undefined {
	if (ms === undefined || ms < DURATION_MIN_MS) return undefined;
	const seconds = ms / 1000;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}
