import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	buildFeed,
	type FeedEntry,
	nextSessionId,
	readMeta,
	asideSessionId,
	TOOL_RESULT_CAP,
	writeMeta,
} from "../extensions/feed.ts";

const user = (id: string, text: string): FeedEntry => ({ type: "message", id, message: { role: "user", content: text } });
const assistant = (id: string, content: unknown[]): FeedEntry => ({
	type: "message",
	id,
	message: { role: "assistant", content },
});
const result = (id: string, text: string): FeedEntry => ({
	type: "message",
	id,
	message: { role: "toolResult", content: [{ type: "text", text }] },
});

test("full feed renders user, assistant, tool call, and tool result", () => {
	const branch: FeedEntry[] = [
		{ type: "message", id: "0", message: { role: "system", content: "sys" } },
		user("1", "hello"),
		assistant("2", [
			{ type: "thinking", thinking: "secret" },
			{ type: "text", text: "hi" },
			{ type: "toolCall", name: "read", arguments: { path: "a.ts", n: 3 } },
		]),
		result("3", "file body"),
		{ type: "model_change", id: "4" },
	];
	const feed = buildFeed(branch, undefined);
	assert.equal(
		feed.text,
		'[User]: hello\n\n[Assistant thinking]: secret\n\n[Assistant]: hi\n\n[Assistant tool calls]: read(path="a.ts", n=3)\n\n[Tool result]: file body',
	);
	assert.equal(feed.cursor, "4");
});

test("delta feed sends only entries after the cursor", () => {
	const branch = [user("1", "one"), assistant("2", [{ type: "text", text: "two" }]), user("3", "three")];
	const feed = buildFeed(branch, "2");
	assert.equal(feed.text, "[User]: three");
	assert.equal(feed.cursor, "3");
	const none = buildFeed(branch, "3");
	assert.equal(none.text, "");
	assert.equal(none.cursor, "3");
});

test("cursor advances over skipped entries", () => {
	const branch = [user("1", "one"), { type: "label", id: "2" }];
	assert.equal(buildFeed(branch, undefined).cursor, "2");
	assert.equal(buildFeed(branch, "1").text, "");
});

const call = (name: string, args: Record<string, unknown>) => assistant("1", [{ type: "toolCall", name, arguments: args }]);

test("thinking renders in content order between text parts", () => {
	const feed = buildFeed(
		[assistant("1", [{ type: "text", text: "a" }, { type: "thinking", thinking: "t".repeat(5000) }, { type: "text", text: "b" }])],
		undefined,
	);
	assert.equal(feed.text, `[Assistant]: a\n\n[Assistant thinking]: ${"t".repeat(5000)}\n\n[Assistant]: b`);
});

test("write keeps long content whole", () => {
	const content = "c".repeat(1000);
	const feed = buildFeed([call("write", { path: "a.ts", content })], undefined);
	assert.equal(feed.text, `[Assistant tool calls]: write(path="a.ts", content="${content}")`);
});

test("edit keeps oldText and newText whole", () => {
	const oldText = "o".repeat(400);
	const newText = "n".repeat(400);
	const feed = buildFeed([call("edit", { path: "a.ts", oldText, newText })], undefined);
	assert.ok(feed.text.includes(`oldText="${oldText}"`));
	assert.ok(feed.text.includes(`newText="${newText}"`));
	assert.ok(!feed.text.includes("[truncated]"));
});

test("bash command is cut at 200", () => {
	const feed = buildFeed([call("bash", { command: "x".repeat(500) })], undefined);
	const json = JSON.stringify("x".repeat(500));
	assert.equal(feed.text, `[Assistant tool calls]: bash(command=${json.slice(0, 200)}... [truncated])`);
});

test("read keeps a long path whole", () => {
	const p = "d/".repeat(200) + "a.ts";
	const feed = buildFeed([call("read", { path: p, other: "y".repeat(300) })], undefined);
	assert.ok(feed.text.includes(`path=${JSON.stringify(p)}`));
	assert.ok(feed.text.endsWith("... [truncated])"));
});

test("tool result is cut at 300", () => {
	const feed = buildFeed([result("1", "x".repeat(TOOL_RESULT_CAP + 50))], undefined);
	assert.equal(feed.text, `[Tool result]: ${"x".repeat(300)}... [truncated]`);
});

test("cursor not on the branch sends the whole branch with a note", () => {
	const feed = buildFeed([user("1", "one"), user("2", "two")], "gone");
	assert.ok(feed.text.startsWith("[Note:"));
	assert.ok(feed.text.includes("[User]: one"));
	assert.ok(feed.text.endsWith("[User]: two"));
	assert.equal(feed.cursor, "2");
});

test("compaction entry is skipped and raw history before it is kept", () => {
	const branch: FeedEntry[] = [
		user("1", "early decision"),
		assistant("2", [{ type: "text", text: "ok" }]),
		{ type: "compaction", id: "3", firstKeptEntryId: "2", summary: "summary text" } as FeedEntry,
		user("4", "later"),
	];
	const feed = buildFeed(branch, undefined);
	assert.ok(feed.text.includes("early decision"));
	assert.ok(!feed.text.includes("summary text"));
	assert.equal(feed.cursor, "4");
});

test("session ids count from aside-{id} and then aside-{id}-{n}", () => {
	assert.equal(asideSessionId("abc"), "aside-abc");
	assert.equal(nextSessionId("abc", "aside-abc"), "aside-abc-2");
	assert.equal(nextSessionId("abc", "aside-abc-2"), "aside-abc-3");
	assert.equal(nextSessionId("abc", "aside-abc-9"), "aside-abc-10");
	assert.equal(nextSessionId("abc", "junk"), "aside-abc-2");
});

test("sidecar round trips with and without a session field and a missing file reads as empty", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aside-feed-"));
	try {
		assert.deepEqual(readMeta(dir, "abc"), {});
		writeMeta(dir, "abc", { cursor: "e9" });
		assert.deepEqual(readMeta(dir, "abc"), { session: undefined, cursor: "e9" });
		assert.ok(fs.existsSync(path.join(dir, "aside-abc.meta.json")));
		writeMeta(dir, "abc", { session: "aside-abc-2" });
		assert.deepEqual(readMeta(dir, "abc"), { session: "aside-abc-2", cursor: undefined });
		writeMeta(dir, "abc", { session: "aside-abc-2", cursor: "e1" });
		assert.deepEqual(readMeta(dir, "abc"), { session: "aside-abc-2", cursor: "e1" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
