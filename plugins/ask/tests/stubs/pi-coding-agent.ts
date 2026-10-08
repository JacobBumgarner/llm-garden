/** Stand-in for pi-coding-agent: a plain theme and an empty markdown theme. */

import type { Color } from "./pi-tui.ts";

export interface Theme {
	colors: Record<string, Color>;
	style(text: string, options: { fg?: Color | string }): string;
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	underline(text: string): string;
}

export function getMarkdownTheme(): Record<string, unknown> {
	return {};
}
