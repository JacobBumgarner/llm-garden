import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitShell } from "../extensions/shell.ts";

describe("splitShell", () => {
	it("leaves a simple command whole", () => {
		assert.deepEqual(splitShell("ls -la"), ["ls -la"]);
		assert.deepEqual(splitShell(""), [""]);
	});

	it("breaks at top-level operators, each opening its segment", () => {
		assert.deepEqual(splitShell("cd x && make | tee log; echo done || exit 1"), [
			"cd x",
			"&& make",
			"| tee log",
			"; echo done",
			"|| exit 1",
		]);
	});

	it("keeps operators inside quotes, escapes, and substitutions", () => {
		assert.deepEqual(splitShell(`echo "a && b | c" 'd; e' f\\|g $(x | y) {a;b} | wc`), [
			`echo "a && b | c" 'd; e' f\\|g $(x | y) {a;b}`,
			"| wc",
		]);
	});

	it("breaks at newlines without an opener", () => {
		assert.deepEqual(splitShell("set -e\nnpm test | tail -3\n"), ["set -e", "npm test", "| tail -3"]);
	});

	it("copies a heredoc body through untouched", () => {
		const command = "cat > f <<'EOF' && echo ok\nfoo | bar; baz\nEOF\nwc -l f | head";
		assert.deepEqual(splitShell(command), ["cat > f <<'EOF'", "&& echo ok", "foo | bar; baz", "EOF", "wc -l f", "| head"]);
	});

	it("keeps a quoted newline inside the segment, one line per row", () => {
		assert.deepEqual(splitShell(`echo "one\ntwo" | cat`), ["echo \"one", "two\"", "| cat"]);
	});

	it("keeps the operator when the line breaks right after it", () => {
		assert.deepEqual(splitShell("cd x &&\n  make &&\n  make test"), ["cd x", "&& make", "&& make test"]);
	});
});
