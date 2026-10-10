/**
 * Parameter validation for the `subagent` tool. Turns the raw tool arguments
 * into one typed request per action, or an error string that lists the fields
 * the action accepts and names the fix. Imports nothing from pi packages.
 */

export const ACTIONS = ["start", "status", "wait", "send", "stop", "resume"] as const;
export type Action = (typeof ACTIONS)[number];
export type Scope = "user" | "project" | "both";
export type Notify = "wake" | "quiet";
export type SendMode = "steer" | "follow_up";

export interface StartTask {
	label: string;
	agent: string;
	task: string;
	cwd?: string;
}

export type SubagentRequest =
	| {
			action: "start";
			tasks: StartTask[];
			background: boolean;
			notify: Notify;
			agentScope: Scope;
			confirmProjectAgents: boolean;
	  }
	| { action: "status" }
	| { action: "wait"; ids?: string[]; timeoutMs?: number }
	| { action: "send"; id: string; message: string; mode: SendMode }
	| { action: "stop"; id: string }
	| { action: "resume"; id: string; answers: Record<string, string>; task?: undefined; background?: boolean }
	| { action: "resume"; id: string; task: string; label?: string; answers?: undefined; background?: boolean };

export const MAX_LABEL_LENGTH = 80;

export type ParseResult = { ok: true; request: SubagentRequest } | { ok: false; error: string };

const FIELDS: Record<Action, readonly string[]> = {
	start: ["label", "agent", "task", "tasks", "background", "notify", "cwd", "agentScope", "confirmProjectAgents"],
	status: [],
	wait: ["ids", "timeout_s"],
	send: ["id", "message", "mode"],
	stop: ["id"],
	resume: ["id", "answers", "task", "label", "background"],
};

const USAGE: Record<Action, string> = {
	start: "label, agent and task, or tasks of label, agent and task (background, notify, cwd, agentScope, confirmProjectAgents optional)",
	status: "no other fields",
	wait: "ids and timeout_s, both optional",
	send: "id and message (mode optional)",
	stop: "id",
	resume: "id and exactly one of answers or task (label optional with task, background optional)",
};

/** Build the error text for an action: what it takes, then the problem and its fix. */
function usageError(action: Action, problem: string): ParseResult {
	return { ok: false, error: `action "${action}" takes ${USAGE[action]}. ${problem}` };
}

/** Join field names as `a`, `a and b`, or `a, b and c`. */
function listFields(fields: string[]): string {
	if (fields.length <= 1) return fields.join("");
	return `${fields.slice(0, -1).join(", ")} and ${fields.at(-1)}`;
}

/**
 * Suggest the action the caller likely meant for fields the given action does
 * not accept. Prefers an action that accepts every field passed, then the one
 * that accepts the extras and shares the most other fields.
 */
function suggestFix(action: Action, passed: string[], extras: string[]): string {
	const others = ACTIONS.filter((candidate) => candidate !== action);
	const fitsAll = others.find((candidate) => passed.every((field) => FIELDS[candidate].includes(field)));
	if (fitsAll && passed.length > 0) return `Did you mean action "${fitsAll}"?`;
	let best: Action | undefined;
	let bestOverlap = -1;
	for (const candidate of others) {
		if (!extras.every((field) => FIELDS[candidate].includes(field))) continue;
		const overlap = passed.filter((field) => FIELDS[candidate].includes(field)).length;
		if (overlap > bestOverlap) {
			best = candidate;
			bestOverlap = overlap;
		}
	}
	const drop = `Drop ${listFields(extras)}`;
	return best ? `${drop}, or did you mean action "${best}" with ${listFields(extras)}?` : `${drop}.`;
}

/** Report whether a value is a string with visible text. */
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const LABEL_FIX = "add a label, a 3 to 7 word title for the run";

/** Trim a label and cap it at `MAX_LABEL_LENGTH` characters. */
function cleanLabel(label: string): string {
	return label.trim().slice(0, MAX_LABEL_LENGTH).trimEnd();
}

/** Validate the tool arguments for their action and return the typed request or the error text. */
export function parseParams(raw: Record<string, unknown>): ParseResult {
	const action = raw.action as Action;
	if (!ACTIONS.includes(action)) {
		return { ok: false, error: `action must be one of ${ACTIONS.map((a) => `"${a}"`).join(", ")}.` };
	}
	const passed = Object.keys(raw).filter((key) => key !== "action" && raw[key] !== undefined);
	const extras = passed.filter((field) => !FIELDS[action].includes(field));
	if (extras.length > 0) {
		const verb = extras.length === 1 ? "is" : "are";
		return usageError(action, `${listFields(extras)} ${verb} not accepted. ${suggestFix(action, passed, extras)}`);
	}
	switch (action) {
		case "start":
			return parseStart(raw);
		case "status":
			return { ok: true, request: { action } };
		case "wait":
			return parseWait(raw);
		case "send":
			return parseSend(raw);
		case "stop":
			return parseStop(raw);
		case "resume":
			return parseResume(raw);
	}
}

/** Validate a send: an id, a message, and an optional mode. */
function parseSend(raw: Record<string, unknown>): ParseResult {
	const missing = ["id", "message"].filter((field) => !isText(raw[field]));
	if (missing.length > 0) return usageError("send", `Missing ${listFields(missing)}.`);
	const mode = raw.mode ?? "steer";
	if (mode !== "steer" && mode !== "follow_up") return usageError("send", 'mode must be "steer" or "follow_up".');
	return { ok: true, request: { action: "send", id: raw.id as string, message: raw.message as string, mode } };
}

/** Validate a stop: an id. */
function parseStop(raw: Record<string, unknown>): ParseResult {
	if (!isText(raw.id)) return usageError("stop", "Missing id.");
	return { ok: true, request: { action: "stop", id: raw.id } };
}

/** List the missing fields of a start task as `label, agent and task.`, followed by the fix when the label is among them. */
function missingFieldsText(missing: string[]): string {
	const fix = missing.includes("label") ? ` To fix it, ${LABEL_FIX}.` : "";
	return `${listFields(missing)}.${fix}`;
}

/** Build one start task from its fields, or return the names of the required fields it lacks. */
function parseStartTask(fields: Record<string, unknown>, defaultCwd?: string): StartTask | { missing: string[] } {
	const missing = ["label", "agent", "task"].filter((field) => !isText(fields[field]));
	if (missing.length > 0) return { missing };
	const cwd = typeof fields.cwd === "string" ? fields.cwd : defaultCwd;
	return { label: cleanLabel(fields.label as string), agent: fields.agent as string, task: fields.task as string, ...(cwd ? { cwd } : {}) };
}

/** Build the tasks of a start from the `tasks` list, or return the problem text. Entries without a cwd take the top-level one. */
function parseTaskList(list: unknown, defaultCwd?: string): StartTask[] | string {
	if (!Array.isArray(list) || list.length === 0) return "tasks is empty.";
	const tasks: StartTask[] = [];
	for (const [index, item] of list.entries()) {
		const task = parseStartTask((item ?? {}) as Record<string, unknown>, defaultCwd);
		if ("missing" in task) return `tasks[${index}] is missing ${missingFieldsText(task.missing)}`;
		tasks.push(task);
	}
	return tasks;
}

/** Validate a start: one agent and task, or a tasks list, plus the start options. */
function parseStart(raw: Record<string, unknown>): ParseResult {
	const hasSingle = raw.agent !== undefined || raw.task !== undefined;
	const hasTasks = raw.tasks !== undefined;
	if (hasSingle && hasTasks) {
		return usageError("start", "You passed both agent/task and tasks. Put every task in tasks, or pass one agent and task.");
	}
	if (hasTasks && raw.label !== undefined) {
		return usageError("start", "label goes inside each tasks entry. Drop the top-level label.");
	}
	const notify = (raw.notify ?? "wake") as Notify;
	if (notify !== "wake" && notify !== "quiet") return usageError("start", 'notify must be "wake" or "quiet".');
	const agentScope = (raw.agentScope ?? "user") as Scope;
	if (!["user", "project", "both"].includes(agentScope)) {
		return usageError("start", 'agentScope must be "user", "project", or "both".');
	}
	const options = {
		background: raw.background === true,
		notify,
		agentScope,
		confirmProjectAgents: raw.confirmProjectAgents !== false,
	};
	const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
	if (hasTasks) {
		const tasks = parseTaskList(raw.tasks, cwd);
		if (typeof tasks === "string") return usageError("start", tasks);
		return { ok: true, request: { action: "start", tasks, ...options } };
	}
	const task = parseStartTask(raw, cwd);
	if ("missing" in task) return usageError("start", `Missing ${missingFieldsText(task.missing)}`);
	return { ok: true, request: { action: "start", tasks: [task], ...options } };
}

/** Validate a wait and convert its timeout to milliseconds. */
function parseWait(raw: Record<string, unknown>): ParseResult {
	let ids: string[] | undefined;
	if (raw.ids !== undefined) {
		if (!Array.isArray(raw.ids) || raw.ids.length === 0 || !raw.ids.every(isText)) {
			return usageError("wait", "ids must be a non-empty list of session ids. Omit it to wait on every live run.");
		}
		ids = raw.ids;
	}
	let timeoutMs: number | undefined;
	if (raw.timeout_s !== undefined) {
		if (typeof raw.timeout_s !== "number" || !(raw.timeout_s > 0)) {
			return usageError("wait", "timeout_s must be a positive number of seconds.");
		}
		timeoutMs = raw.timeout_s * 1000;
	}
	return { ok: true, request: { action: "wait", ...(ids ? { ids } : {}), ...(timeoutMs ? { timeoutMs } : {}) } };
}

/** Validate a resume: an id, exactly one of answers or task, and an optional boolean background. */
function parseResume(raw: Record<string, unknown>): ParseResult {
	if (!isText(raw.id)) return usageError("resume", "Missing id.");
	const hasAnswers = raw.answers !== undefined;
	const hasTask = raw.task !== undefined;
	if (hasAnswers === hasTask) {
		return usageError(
			"resume",
			hasAnswers
				? "You passed both answers and task. Pass answers for a paused run, or task for follow-up work."
				: "Missing answers or task. Pass answers for a paused run, or task for follow-up work.",
		);
	}
	if (raw.background !== undefined && typeof raw.background !== "boolean") {
		return usageError("resume", "background must be true or false.");
	}
	const background = raw.background === undefined ? {} : { background: raw.background };
	if (hasTask) {
		if (!isText(raw.task)) return usageError("resume", "task is empty.");
		if (raw.label === undefined) return { ok: true, request: { action: "resume", id: raw.id, task: raw.task, ...background } };
		if (!isText(raw.label)) return usageError("resume", "label is empty. Omit it to keep the run's label.");
		return { ok: true, request: { action: "resume", id: raw.id, task: raw.task, label: cleanLabel(raw.label), ...background } };
	}
	if (raw.label !== undefined) {
		return usageError("resume", "label is accepted only with task. Drop it, or send follow-up work with task.");
	}
	const answers = raw.answers;
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
		return usageError("resume", "answers must map question ids to answer text.");
	}
	const entries = Object.entries(answers);
	if (entries.length === 0 || !entries.every(([, value]) => typeof value === "string")) {
		return usageError("resume", "answers must map at least one question id to answer text.");
	}
	return { ok: true, request: { action: "resume", id: raw.id, answers: answers as Record<string, string>, ...background } };
}
