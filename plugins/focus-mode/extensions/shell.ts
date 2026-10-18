/**
 * Break a shell command into display segments so a long pipeline reads one step per line.
 *
 * A new segment starts at each top-level `&&`, `||`, `|`, `;`, or newline. Quoted text, backslash
 * escapes, `$(...)`, `{...}`, and heredoc bodies are left whole, so an operator inside them never
 * splits. Segments after the first open with the operator that preceded them (`&& `, `| `), and a
 * newline break opens with nothing. This is for reading, not re-execution: the segments joined with
 * spaces are not guaranteed to equal the command.
 */

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** The heredoc terminator words a line opens, in order, when the line is a top-level one. */
function heredocWords(line: string): string[] {
	const words: string[] = [];
	for (const match of line.matchAll(HEREDOC)) words.push(match[2]!);
	return words;
}

export function splitShell(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | undefined;
	let depth = 0;
	/** Terminators of heredocs opened on the current line, consumed after its newline. */
	let pending: string[] = [];
	/** The terminator of the heredoc body being copied, if any. */
	let bodyEnd: string | undefined;

	/** Emit the current segment, one line per newline it spans (a quoted or parenthesised break), and open the next. */
	let opener = "";
	const flush = (next: string): void => {
		const text = cur.trim();
		if (text) out.push(...`${opener}${text}`.split("\n"));
		cur = "";
		// A newline right after an operator (`a &&\n b`) keeps the operator for the segment that follows.
		opener = text || next ? next : opener;
	};

	const lines = command.split("\n");
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n]!;
		if (bodyEnd !== undefined) {
			out.push(line);
			if (line.trim() === bodyEnd) bodyEnd = pending.shift();
			continue;
		}
		for (let i = 0; i < line.length; i++) {
			const c = line[i]!;
			const next = line[i + 1];
			if (quote) {
				cur += c;
				if (c === "\\" && quote === '"' && next !== undefined) {
					cur += next;
					i++;
				} else if (c === quote) {
					quote = undefined;
				}
				continue;
			}
			if (c === "\\") {
				cur += c + (next ?? "");
				i++;
				continue;
			}
			if (c === "'" || c === '"') {
				quote = c;
				cur += c;
				continue;
			}
			if (c === "(" || c === "{") depth++;
			else if (c === ")" || c === "}") depth = Math.max(0, depth - 1);
			if (depth === 0) {
				if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
					flush(`${c}${c} `);
					i++;
					continue;
				}
				if (c === "|" || c === ";") {
					flush(`${c} `);
					continue;
				}
			}
			cur += c;
		}
		pending.push(...heredocWords(line));
		if (quote === undefined && depth === 0) {
			flush("");
			bodyEnd = pending.shift();
		} else {
			cur += "\n";
		}
	}
	flush("");
	return out.length === 0 ? [""] : out;
}
