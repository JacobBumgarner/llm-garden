/**
 * Turn one tool item into plain display lines, one renderer per known tool and a default.
 *
 * Single-line surfaces (the transcript strips, the subagent overlay rows) take the default summary,
 * where a bash command is its first line. The actions panel asks for the `full` summary, where a
 * bash command is broken by `splitShell` into one segment per line, continuation lines indented to
 * sit under the command text.
 */

import { splitShell } from "./shell.ts";
import type { ToolItem } from "./types.ts";

const RUNNING = "…";
/** Indent for a bash continuation line: the width of the `$ ` prompt, plus the running mark when drawn. */
const PROMPT = "$ ";

export interface SummarizeOptions {
	/** Show every line of a multi-line or chained bash command instead of its first line. */
	full?: boolean;
}

const KEY_ARGS: Record<string, string> = {
	read: "path",
	ls: "path",
	grep: "pattern",
	find: "pattern",
};

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function firstStringArg(args: Record<string, unknown>): string | undefined {
	for (const value of Object.values(args)) {
		if (typeof value === "string") return value;
	}
	return undefined;
}

function withName(name: string, arg: string | undefined): string {
	return arg === undefined || arg === "" ? name : `${name} ${arg}`;
}

/** Count changed lines in the edit tool's `details.diff`, where each line leads with `+`, `-`, or a space. */
function countDiff(diff: unknown): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	if (typeof diff !== "string") return { added, removed };
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function lineCount(content: string): number {
	if (content === "") return 0;
	const lines = content.split("\n");
	return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Render one `ask` answer as text: chosen option labels, free text, or a status word. */
function askAnswerText(question: Record<string, unknown>, answer: Record<string, unknown> | undefined): string {
	if (!answer) return "unanswered";
	switch (answer.kind) {
		case "selected": {
			const options = asArray(question.options).map(asRecord);
			return asArray(answer.indices)
				.map((i) => (typeof i === "number" ? str(options[i]?.label) : undefined))
				.filter((label): label is string => label !== undefined)
				.join(", ");
		}
		case "text":
			return str(answer.text) ?? "";
		case "clarify":
			return "clarify";
		default:
			return "";
	}
}

function summarizeAsk(item: ToolItem, running: boolean): string[] {
	const details = asRecord(item.result?.details);
	const result = asRecord(details.result);
	if (result.cancelled === true) return [mark("cancelled", running)];
	const questions = asArray(details.questions).map(asRecord);
	const answers = asArray(result.answers).map(asRecord);
	if (questions.length === 0) return [mark("ask", running)];
	return questions.map((question) => {
		const entry = answers.find((a) => a.id !== undefined && a.id === question.id);
		const answer = entry ? asRecord(entry.answer) : undefined;
		return mark(`? ${str(question.question) ?? ""} -> ${askAnswerText(question, answer)}`, running);
	});
}

function tokens(n: unknown): string | undefined {
	if (typeof n !== "number" || n <= 0) return undefined;
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

/** Turns, tokens, and cost from a run's usage, skipping the parts that are zero. */
function usageParts(usage: Record<string, unknown>): string[] {
	const parts: string[] = [];
	if (typeof usage.turns === "number" && usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	const up = tokens(usage.input);
	const down = tokens(usage.output);
	if (up || down) parts.push([up && `↑${up}`, down && `↓${down}`].filter(Boolean).join(" "));
	return parts;
}

/** Progress text for one run snapshot: usage and cost, then the last tool while running or the state word otherwise. */
function runProgress(run: Record<string, unknown>): string[] {
	const usage = asRecord(run.usage);
	const parts = usageParts(usage);
	if (typeof usage.cost === "number" && usage.cost > 0) parts.push(`$${usage.cost.toFixed(2)}`);
	if (run.state !== "running") return [...parts, str(run.state) ?? ""].filter(Boolean);
	const tool = str(asRecord(run.lastTool).name);
	if (tool) parts.push(`→ ${tool}`);
	return parts;
}

/** The states a status line counts as still going. */
const LIVE_STATES = new Set(["queued", "running"]);

/**
 * One line for a `status` call, which carries every run of the session: counts by running,
 * paused, and finished, so a long session does not draw a row per run.
 */
function statusLine(runs: Record<string, unknown>[]): string {
	let running = 0;
	let paused = 0;
	for (const run of runs) {
		if (LIVE_STATES.has(str(run.state) ?? "")) running++;
		else if (run.state === "paused") paused++;
	}
	const finished = runs.length - running - paused;
	const parts = [`${running} running`];
	if (paused > 0) parts.push(`${paused} paused`);
	parts.push(`${finished} finished`);
	return ["subagent status", ...parts].join(" · ");
}

/** Join a run's identity and trailing parts into one `subagent` line. */
function runLine(agent: string | undefined, label: string | undefined, rest: string[]): string {
	return [`subagent ${agent ?? ""}`.trimEnd(), ...(label ? [label] : []), ...rest].join(" · ");
}

/** Lines for a call that has no result details yet, built from its arguments. */
function subagentArgsLines(args: Record<string, unknown>): string[] {
	const tasks = asArray(args.tasks).map(asRecord);
	if (tasks.length > 0) return tasks.map((task) => runLine(str(task.agent), str(task.label), []));
	const action = str(args.action);
	if (action === undefined || action === "start") return [runLine(str(args.agent), str(args.label), [])];
	const ids = asArray(args.ids).filter((id): id is string => typeof id === "string");
	const target = str(args.id) ?? ids.join(" ");
	const label = str(args.label);
	return [withName(withName("subagent", action), target) + (label ? ` · ${label}` : "")];
}

function summarizeSubagent(item: ToolItem, running: boolean): string[] {
	const runs = asArray(asRecord(item.result?.details).runs).map(asRecord);
	if (runs.length === 0) return subagentArgsLines(item.args).map((line) => mark(line, running));
	if (item.args.action === "status") return [mark(statusLine(runs), running)];
	return runs.map((run) => {
		const base = runLine(str(run.agent), str(run.label), runProgress(run));
		return mark(run.state === "failed" ? `${base} error` : base, running);
	});
}

function mark(line: string, running: boolean): string {
	return running ? `${RUNNING} ${line}` : line;
}

/** The `$ command` line(s): the first line alone, or every `splitShell` segment with an error marker on the first. */
function summarizeBash(item: ToolItem, running: boolean, full: boolean): string[] {
	const command = str(item.args.command) ?? "";
	const segments = full ? splitShell(command) : [command.split("\n")[0]!];
	const head = `${PROMPT}${segments[0]}`;
	const first = mark(item.result?.isError ? `${head} error` : head, running);
	const indent = " ".repeat(PROMPT.length + (running ? RUNNING.length + 1 : 0));
	return [first, ...segments.slice(1).map((segment) => indent + segment)];
}

/** Summarize a tool item as plain strings: one line for most tools, one per question for ask, one per segment for a full bash. */
export function summarize(item: ToolItem, options: SummarizeOptions = {}): string[] {
	const running = item.result === undefined || item.result.partial === true;
	const args = item.args;
	switch (item.name) {
		case "edit": {
			const { added, removed } = countDiff(asRecord(item.result?.details).diff);
			const path = str(args.path) ?? "";
			const base = running ? `edit ${path}` : `edit ${path} +${added} -${removed}`;
			return [mark(base, running)];
		}
		case "write": {
			const content = str(args.content) ?? "";
			return [mark(`write ${str(args.path) ?? ""} (${lineCount(content)} lines)`, running)];
		}
		case "bash":
			return summarizeBash(item, running, options.full === true);
		case "read":
		case "ls":
		case "grep":
		case "find":
			return [mark(withName(item.name, str(args[KEY_ARGS[item.name]])), running)];
		case "ask":
			return summarizeAsk(item, running);
		case "subagent":
			return summarizeSubagent(item, running);
		default:
			return [mark(withName(item.name, firstStringArg(args)), running)];
	}
}
