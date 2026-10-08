/** Shared shapes for the ask tool. Types only, no pi import. */

import type { KeyName } from "./keys.ts";

export type { KeyName };

export interface AskOption {
	label: string;
	tradeoff?: string;
	/** Why this is the option to pick; set on at most one option per question. */
	recommended?: string;
	preview?: string;
}

export interface AskQuestion {
	id: string;
	/** Tab text, derived from the id; not part of the call. */
	label?: string;
	question: string;
	context?: string;
	options?: AskOption[];
	multi?: boolean;
}

export interface AskCall {
	questions: AskQuestion[];
}

export type Answer =
	| { kind: "selected"; indices: number[] }
	| { kind: "text"; text: string }
	| { kind: "clarify" };

export type AskResult = {
	answers: { id: string; answer: Answer; note?: string }[];
	cancelled: boolean;
};

export interface FormState {
	questions: AskQuestion[];
	current: number;
	cursor: number;
	mode: "list" | "text" | "note";
	checked: Map<string, Set<number>>;
	drafts: Map<string, string>;
	notes: Map<string, string>;
	noteDraft: string;
	answers: Map<string, Answer>;
	result?: AskResult;
}

export type FormEvent =
	| { type: "key"; key: KeyName }
	/** A typed digit on an option list: the 1-based number of a row to act on. */
	| { type: "pick"; number: number }
	/** A click on a list row: move the cursor there and press Enter. */
	| { type: "activate"; cursor: number }
	/** A click on a question's tab. */
	| { type: "jump"; question: number }
	| { type: "draft"; text: string }
	| { type: "noteDraft"; text: string };
