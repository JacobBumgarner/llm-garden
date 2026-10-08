/**
 * Module resolution hook for the tests: points pi's packages at the stubs so
 * the view loads under plain `node --test`, where pi is not installed.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const STUBS: Record<string, string> = {
	"@earendil-works/pi-tui": "pi-tui.ts",
	"@earendil-works/pi-coding-agent": "pi-coding-agent.ts",
};

const stubsDir = join(dirname(fileURLToPath(import.meta.url)), "stubs");

export function resolve(
	specifier: string,
	context: unknown,
	next: (specifier: string, context: unknown) => unknown,
): unknown {
	const stub = STUBS[specifier];
	if (!stub) return next(specifier, context);
	return { url: pathToFileURL(join(stubsDir, stub)).href, shortCircuit: true };
}
