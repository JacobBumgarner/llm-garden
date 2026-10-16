/**
 * Brief discovery. A brief is a markdown file of standing instructions for one
 * delegate job, named by its path under a briefs directory without `.md`, so
 * `briefs/orchestration/critic.md` is `orchestration/critic`. The bundled
 * directory is `plugins/subagent/briefs/`, and `~/.pi/agent/briefs/` is read
 * after it, so a user file wins on a name collision.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** Briefs shipped with this plugin, at `plugins/subagent/briefs/`. */
export const BUNDLED_BRIEFS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "briefs");

export interface BriefConfig {
	name: string;
	description: string;
	filePath: string;
}

interface BriefFrontmatter {
	name?: unknown;
	description?: unknown;
}

/** Read every `.md` under `dir`, one directory deep, keyed by `group/name` or `name`. Files without frontmatter name and description are skipped. */
function loadBriefsFromDir(dir: string): BriefConfig[] {
	const briefs: BriefConfig[] = [];
	for (const filePath of listMarkdown(dir)) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter } = parseFrontmatter<BriefFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		briefs.push({ name: frontmatter.name, description: frontmatter.description, filePath });
	}
	return briefs;
}

/** The markdown files in `dir` and in its immediate subdirectories. */
function listMarkdown(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readDir(dir)) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const child of readDir(full)) {
				if (child.name.endsWith(".md") && (child.isFile() || child.isSymbolicLink())) files.push(path.join(full, child.name));
			}
		} else if (entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())) {
			files.push(full);
		}
	}
	return files;
}

function readDir(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Bundled briefs, then the user's, with the user's winning on a name collision. */
export function discoverBriefs(userDir: string = path.join(getAgentDir(), "briefs")): BriefConfig[] {
	const byName = new Map<string, BriefConfig>();
	for (const brief of [...loadBriefsFromDir(BUNDLED_BRIEFS_DIR), ...loadBriefsFromDir(userDir)]) byName.set(brief.name, brief);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One line per brief for the tool description: `name: description`. */
export function describeBriefs(briefs: BriefConfig[]): string {
	return briefs.length === 0 ? "none" : briefs.map((brief) => `${brief.name}: ${brief.description}`).join("; ");
}
