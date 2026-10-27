import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findInSources, normalize } from "../extensions/source-text.ts";

const paragraph = "First paragraph that is long enough to wrap in a narrow terminal.\n\nSecond paragraph here.";

describe("normalize", () => {
	test("collapses whitespace runs and maps back to source offsets", () => {
		const { text, map } = normalize("  a \n\n b\tc  ");
		assert.equal(text, "a b c");
		assert.deepEqual(map.map((i) => "  a \n\n b\tc  "[i]), ["a", " ", "b", "\t", "c"]);
	});
});

describe("findInSources", () => {
	test("joins a wrapped row back into the source sentence", () => {
		const screen = " paragraph that is long enough to\n wrap in a narrow";
		assert.equal(findInSources(screen, [paragraph]), "paragraph that is long enough to wrap in a narrow");
	});

	test("keeps the blank line the author wrote", () => {
		const screen = " narrow terminal.\n\n Second para";
		assert.equal(findInSources(screen, [paragraph]), "narrow terminal.\n\nSecond para");
	});

	test("preserves indentation inside a code block", () => {
		const code = "```python\ndef f():\n    return 1\n```";
		const screen = " def f():\n     return 1";
		assert.equal(findInSources(screen, [code]), "def f():\n    return 1");
	});

	test("searches sources in order and returns the first hit", () => {
		assert.equal(findInSources("x", ["a x b", "x"]), "x");
		assert.equal(findInSources("x", ["a y b", "c x d"]), "x");
	});

	test("returns undefined for an empty or unmatched selection", () => {
		assert.equal(findInSources("   \n ", [paragraph]), undefined);
		assert.equal(findInSources("not in there", [paragraph]), undefined);
	});
});
