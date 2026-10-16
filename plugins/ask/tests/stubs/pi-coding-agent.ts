/** Stand-in for pi-coding-agent: a plain theme and an empty markdown theme. */

import type { Color } from "./pi-tui.ts";

export interface Theme {
	colors: Record<string, Color>;
	style(text: string, options: { fg?: Color | string }): string;
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
}

export function getMarkdownTheme(): Record<string, unknown> {
	return {};
}

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? "/nonexistent/.pi/agent";
}

/** Split a leading `---` block into parsed scalar fields and the remaining body. Values are plain strings. */
export function parseFrontmatter<T extends object>(content: string): { frontmatter: Partial<T>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		frontmatter[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return { frontmatter: frontmatter as Partial<T>, body: content.slice(match[0].length) };
}
