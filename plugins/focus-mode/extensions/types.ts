/**
 * The tool call shape the summarizer and strip layout work from.
 */

/** One tool call with whatever result has arrived so far. */
export interface ToolItem {
	name: string;
	args: Record<string, unknown>;
	result?: { text: string; details: unknown; isError: boolean; partial?: boolean };
}
