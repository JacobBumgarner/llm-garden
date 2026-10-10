import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { durationLabel, editDiffLines, expansionLines, MAX_RESULT_LINES, resultText, stripColor } from "../extensions/strip.ts";

describe("stripColor", () => {
	it("is pending without a result or with a partial one", () => {
		assert.equal(stripColor({ name: "bash", args: {} }), "muted");
		assert.equal(stripColor({ name: "bash", args: {}, result: { text: "", details: undefined, isError: false, partial: true } }), "muted");
	});
	it("is error or success on a final result", () => {
		assert.equal(stripColor({ name: "bash", args: {}, result: { text: "", details: undefined, isError: true } }), "error");
		assert.equal(stripColor({ name: "bash", args: {}, result: { text: "", details: undefined, isError: false } }), "success");
	});
});

describe("expansionLines", () => {
	it("lists args only while running", () => {
		assert.deepEqual(expansionLines({ name: "bash", args: { command: "ls", timeout: 5 } }), ["command: ls", "timeout: 5"]);
	});
	it("caps the result and reports the remainder", () => {
		const text = Array.from({ length: MAX_RESULT_LINES + 3 }, (_, i) => `l${i}`).join("\n");
		const lines = expansionLines({ name: "bash", args: {}, result: { text, details: undefined, isError: false } });
		assert.equal(lines[0], "");
		assert.equal(lines.length, 1 + MAX_RESULT_LINES + 1);
		assert.equal(lines.at(-1), "… 3 more lines");
	});
	it("adds no result lines for empty output", () => {
		assert.deepEqual(expansionLines({ name: "ls", args: { path: "." }, result: { text: "", details: undefined, isError: false } }), ["path: .", ""]);
	});
});

describe("editDiffLines", () => {
	it("splits a finished edit's diff into lines", () => {
		const result = { text: "ok", details: { diff: "   1 a\n-  2 b\n+  2 c" }, isError: false };
		assert.deepEqual(editDiffLines({ name: "edit", args: {}, result }), ["   1 a", "-  2 b", "+  2 c"]);
	});
	it("is undefined for other tools, running edits, and results without a diff", () => {
		const result = { text: "", details: { diff: "+ 1 a" }, isError: false };
		assert.equal(editDiffLines({ name: "write", args: {}, result }), undefined);
		assert.equal(editDiffLines({ name: "edit", args: {} }), undefined);
		assert.equal(editDiffLines({ name: "edit", args: {}, result: { ...result, partial: true } }), undefined);
		assert.equal(editDiffLines({ name: "edit", args: {}, result: { text: "", details: {}, isError: false } }), undefined);
	});
});

describe("resultText", () => {
	it("joins text blocks and skips the rest", () => {
		assert.equal(resultText([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }]), "a\nb");
		assert.equal(resultText(undefined), "");
	});
});

describe("durationLabel", () => {
	it("hides short and unknown durations", () => {
		assert.equal(durationLabel(undefined), undefined);
		assert.equal(durationLabel(1999), undefined);
	});
	it("formats seconds and minutes", () => {
		assert.equal(durationLabel(4200), "4s");
		assert.equal(durationLabel(4600), "5s");
		assert.equal(durationLabel(65_000), "1m 05s");
	});
});
