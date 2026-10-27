// Finds a screen selection in the text it was rendered from.
//
// A selection copied from the terminal has a newline at every row boundary,
// including rows pi only wrapped to fit the width. The source text has only
// the newlines the author wrote. Collapsing whitespace on both sides makes
// them comparable, and an offset map turns the match back into a slice of
// the source. Markdown delimiters the renderer never draws (backticks,
// emphasis markers, link brackets) are skipped on both sides too, so a
// paragraph with inline code still matches.

const IGNORED = /[`*_~[\]]/;

/** `text` with whitespace collapsed and markdown delimiters dropped; `map[i]` is the source offset of `text[i]`. */
export function normalize(source: string): { text: string; map: number[] } {
	let text = "";
	const map: number[] = [];
	let inSpace = true;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (IGNORED.test(ch)) continue;
		if (/\s/.test(ch)) {
			if (!inSpace) {
				text += " ";
				map.push(i);
				inSpace = true;
			}
		} else {
			text += ch;
			map.push(i);
			inSpace = false;
		}
	}
	if (text.endsWith(" ")) {
		text = text.slice(0, -1);
		map.pop();
	}
	return { text, map };
}

/** The slice of the first source containing `selection`, with the source's own line breaks. */
export function findInSources(selection: string, sources: Iterable<string>): string | undefined {
	const needle = normalize(selection).text;
	if (needle.length === 0) return undefined;
	for (const source of sources) {
		const { text, map } = normalize(source);
		const start = text.indexOf(needle);
		if (start === -1) continue;
		const end = map[start + needle.length - 1] + 1;
		return source.slice(map[start], end);
	}
	return undefined;
}
