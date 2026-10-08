/**
 * Turn one tool item into plain display lines, one renderer per known tool and a default.
 */

import type { ToolItem } from "./types.ts";

const RUNNING = "…";

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

/** Name of the most recent tool the subagent called, from its last assistant message. */
function lastToolCall(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = asRecord(messages[i]);
		if (msg.role !== "assistant") continue;
		const calls = asArray(msg.content)
			.map(asRecord)
			.filter((block) => block.type === "toolCall");
		const last = calls.at(-1);
		if (last) return str(last.name);
	}
	return undefined;
}

/** Live progress for one subagent result: turns, tokens, cost, and the tool it last called. */
function subagentProgress(r: Record<string, unknown>, running: boolean): string[] {
	const usage = asRecord(r.usage);
	const parts: string[] = [];
	if (typeof usage.turns === "number" && usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	const up = tokens(usage.input);
	const down = tokens(usage.output);
	if (up || down) parts.push([up && `↑${up}`, down && `↓${down}`].filter(Boolean).join(" "));
	if (typeof usage.cost === "number" && usage.cost > 0) parts.push(`$${usage.cost.toFixed(2)}`);
	const tool = running ? lastToolCall(asArray(r.messages)) : undefined;
	if (tool) parts.push(`→ ${tool}`);
	return parts;
}

function summarizeSubagent(item: ToolItem, running: boolean): string[] {
	const details = asRecord(item.result?.details);
	const results = asArray(details.results).map(asRecord);
	if (results.length === 0) {
		return [mark(withName("subagent", firstStringArg(item.args)), running)];
	}
	return results.map((r) => {
		const base = [`subagent ${str(r.agent) ?? ""}`, ...subagentProgress(r, running)].join(" · ");
		const failed = typeof r.exitCode === "number" && r.exitCode !== 0;
		return mark(failed ? `${base} error` : base, running);
	});
}

function mark(line: string, running: boolean): string {
	return running ? `${RUNNING} ${line}` : line;
}

/** Summarize a tool item as plain strings: one line for most tools, one per question for ask. */
export function summarize(item: ToolItem): string[] {
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
		case "bash": {
			const command = (str(args.command) ?? "").split("\n")[0];
			const base = `$ ${command}`;
			return [mark(item.result?.isError ? `${base} error` : base, running)];
		}
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
