/**
 * The action log: every tool call the agent made this session, in order, with status and a capped
 * tail of its output, grouped by the assistant message that issued it.
 *
 * Entries arrive from pi's tool execution events as the agent runs, from the session branch when a
 * session is joined, or from another agent's message history. A group is one turn's calls, from a user message to the next, labeled with
 * the first line of that message; the transcript's hidden mode draws one counter line per group,
 * and the panel heads each group with its label.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { diffCounts, editDiffLines, resultText } from "./strip.ts";
import type { ToolItem } from "./types.ts";

/** Lines of output kept per entry. */
export const TAIL_LINES = 5;

export interface ActionEntry extends ToolItem {
	id: string;
	group: number;
	/** The step the call belongs to: a run of assistant messages unbroken by assistant text. */
	step: number;
	/** Set when another tool made this call; it is drawn indented and left out of group counts. */
	parentId?: string;
	startedAt?: number;
	durationMs?: number;
	/** Last lines of the result so far, or of the edit diff for an edit. */
	tail: string[];
}

/** What a group's counter line reports: top-level calls only, plus the lines its edits added and removed. */
export interface GroupCount {
	total: number;
	running: number;
	errors: number;
	added: number;
	removed: number;
}

export type LogListener = (entry: ActionEntry) => void;

/** Characters of the user message kept as a group label. */
const LABEL_MAX = 120;

/** The first non-blank line of a user message's text, clipped; blocks other than text are skipped. */
export function labelFor(content: unknown): string {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
						.map((block) => block.text)
						.join("\n")
				: "";
	const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
	return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}\u2026` : line;
}

/** Whether an assistant message's content carries a non-blank text block. */
export function hasText(content: unknown): boolean {
	if (!Array.isArray(content)) return typeof content === "string" && content.trim() !== "";
	return content.some(
		(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
	);
}

function isRunning(entry: ActionEntry): boolean {
	return entry.result === undefined || entry.result.partial === true;
}

/** The result's trailing non-blank lines, capped; an edit shows the end of its diff instead. */
export function tailOf(item: ToolItem): string[] {
	const diff = editDiffLines(item);
	const lines = (diff ?? (item.result?.text ?? "").split("\n")).filter((line) => line.trim() !== "");
	return lines.slice(-TAIL_LINES);
}

/** Ordered, grouped record of tool calls, with change notification for live views. */
export class ActionLog {
	private entries = new Map<string, ActionEntry>();
	private order: string[] = [];
	private listeners = new Set<LogListener>();
	/** Tools that keep their own transcript rendering and so are left out of group counts. */
	private excluded: Set<string>;
	private group = 0;
	private step = 0;
	private labels = new Map<number, string>();
	/** Groups whose turn has ended; their counter line lives in the transcript entry appended then. */
	private closed = new Set<number>();
	/** Entries changed since the last flush, delivered to listeners in one microtask. */
	private pending = new Map<string, ActionEntry>();

	constructor(excluded: Iterable<string> = []) {
		this.excluded = new Set(excluded);
	}

	/** The current group index; calls first seen now belong to it. */
	get currentGroup(): number {
		return this.group;
	}

	/** Every entry in call order. */
	all(): ActionEntry[] {
		return this.order.map((id) => this.entries.get(id)!);
	}

	/** Entries the panel lists: everything but the tools that keep their own transcript rendering. */
	visible(): ActionEntry[] {
		return this.all().filter((entry) => !this.excluded.has(entry.name));
	}

	get(id: string): ActionEntry | undefined {
		return this.entries.get(id);
	}

	onChange(listener: LogListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Open a new group and a new step: the next calls belong to a fresh turn, headed by `label` in the panel. */
	nextGroup(label = ""): void {
		this.group++;
		this.step++;
		if (label) this.labels.set(this.group, label);
	}

	/**
	 * Open a new step: the next calls stand behind their own counter. Call it when assistant text
	 * is drawn, so consecutive tool-only assistant messages share one counter.
	 */
	nextStep(): void {
		this.step++;
	}

	/** Every group opened so far, in order, including ones with no calls. */
	groups(): number[] {
		return Array.from({ length: this.group }, (_, i) => i + 1);
	}

	/** The user message line that opened a group, or empty when unknown. */
	label(group: number): string {
		return this.labels.get(group) ?? "";
	}

	/** Record a call, or return the existing entry when it is already known. */
	add(id: string, name: string, args: Record<string, unknown>, parentId?: string): ActionEntry {
		let entry = this.entries.get(id);
		if (entry) {
			entry.args = args;
			return entry;
		}
		const parent = parentId === undefined ? undefined : this.entries.get(parentId);
		const group = parent?.group ?? this.group;
		const step = parent?.step ?? this.step;
		entry = { id, group, step, name, args, tail: [], ...(parentId === undefined ? {} : { parentId }) };
		this.entries.set(id, entry);
		this.order.push(id);
		this.notify(entry);
		return entry;
	}

	/** Mark a call as executing. */
	start(id: string, name: string, args: Record<string, unknown>, parentId?: string): void {
		const entry = this.add(id, name, args, parentId);
		entry.startedAt ??= Date.now();
		this.notify(entry);
	}

	/** Record a partial or final result; the tail follows it. */
	result(id: string, result: ToolItem["result"], durationMs?: number): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.result = result;
		entry.tail = tailOf(entry);
		if (result && result.partial !== true) {
			entry.durationMs ??=
				durationMs ?? (entry.startedAt === undefined ? undefined : Date.now() - entry.startedAt);
		}
		this.notify(entry);
	}

	/** Mark a group's turn as ended, so no call of it draws the counter line. */
	closeGroup(group: number): void {
		this.closed.add(group);
	}

	isClosed(group: number): boolean {
		return this.closed.has(group);
	}

	/**
	 * Whether `id` is the latest counted call of a still-open group, which the in-flight counter line
	 * stands on.
	 */
	isGroupTail(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry || this.closed.has(entry.group)) return false;
		return this.isTail(entry, (other) => other.group === entry.group);
	}

	/** Whether `id` is the latest counted call of its assistant message, which a per-step counter line stands on. */
	isStepTail(id: string): boolean {
		const entry = this.entries.get(id);
		return entry !== undefined && this.isTail(entry, (other) => other.step === entry.step);
	}

	private isTail(entry: ActionEntry, same: (other: ActionEntry) => boolean): boolean {
		if (!this.counts(entry)) return false;
		for (let i = this.order.length - 1; i >= 0; i--) {
			const other = this.entries.get(this.order[i]!)!;
			if (!same(other) || !this.counts(other)) continue;
			return other.id === entry.id;
		}
		return false;
	}

	/** The ids of every entry in a group, in call order. */
	groupIds(group: number): string[] {
		return this.order.filter((id) => this.entries.get(id)!.group === group);
	}

	/** Counts for a group's counter line. */
	groupCount(group: number): GroupCount {
		return this.countWhere((entry) => entry.group === group);
	}

	/** Counts for one assistant message's counter line. */
	stepCount(step: number): GroupCount {
		return this.countWhere((entry) => entry.step === step);
	}

	private countWhere(match: (entry: ActionEntry) => boolean): GroupCount {
		const count: GroupCount = { total: 0, running: 0, errors: 0, added: 0, removed: 0 };
		for (const entry of this.entries.values()) {
			if (!match(entry) || !this.counts(entry)) continue;
			count.total++;
			if (isRunning(entry)) count.running++;
			else if (entry.result?.isError) count.errors++;
			const diff = diffCounts(entry);
			count.added += diff.added;
			count.removed += diff.removed;
		}
		return count;
	}

	/** Load the messages recorded on a session branch (see `addMessages`); every group loaded is closed, since no turn is running. */
	seed(branch: SessionEntry[]): void {
		this.addMessages(branch.flatMap((item) => (item.type === "message" ? [item.message] : [])));
		for (let group = 1; group <= this.group; group++) this.closed.add(group);
	}

	/**
	 * Load a run of messages: each user message opens a group, the tool calls of the assistant
	 * messages after it join it, an assistant message with text opens a step before its calls, and
	 * tool result messages complete them. Leaves the log positioned
	 * at the last group. With `live`, a call without a result yet counts as started now, so its
	 * elapsed time ticks; without it such a call is one that never ran.
	 */
	addMessages(messages: unknown[], live = false): void {
		for (const item of messages) {
			const message = item as { role: string } & Record<string, unknown>;
			if (message.role === "user") {
				this.nextGroup(labelFor(message.content));
			} else if (message.role === "assistant") {
				if (hasText(message.content)) this.step++;
				const content = message.content as { type: string; id?: string; name?: string; arguments?: unknown }[];
				for (const block of content) {
					if (block.type !== "toolCall" || !block.id || !block.name) continue;
					const args = (block.arguments ?? {}) as Record<string, unknown>;
					if (live) this.start(block.id, block.name, args);
					else this.add(block.id, block.name, args);
				}
			} else if (message.role === "toolResult") {
				const id = message.toolCallId as string;
				if (!this.entries.has(id)) continue;
				this.result(
					id,
					{ text: resultText(message.content), details: message.details, isError: message.isError === true },
					message.durationMs as number | undefined,
				);
			}
		}
	}

	private counts(entry: ActionEntry): boolean {
		return entry.parentId === undefined && !this.excluded.has(entry.name);
	}

	/**
	 * Queue a change for the listeners. Delivery is deferred to a microtask and coalesced per entry,
	 * since changes are often recorded from inside a renderer and a listener may redraw the component
	 * doing the rendering.
	 */
	private notify(entry: ActionEntry): void {
		if (this.pending.size === 0) queueMicrotask(() => this.flush());
		this.pending.set(entry.id, entry);
	}

	private flush(): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) for (const listener of this.listeners) listener(entry);
	}
}
