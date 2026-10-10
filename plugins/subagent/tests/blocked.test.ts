import assert from "node:assert/strict";
import { test } from "node:test";
import { createBlockedCalls, shouldDetachOnInput, type DetachReason } from "../extensions/blocked.ts";

test("detachAll invokes each callback with the reason and empties the tracker", () => {
	const blocked = createBlockedCalls();
	const seen: string[] = [];
	blocked.enter((reason) => seen.push(`a:${reason}`));
	blocked.enter((reason) => seen.push(`b:${reason}`));
	assert.equal(blocked.size(), 2);
	assert.equal(blocked.detachAll("user-input"), 2);
	assert.deepEqual(seen, ["a:user-input", "b:user-input"]);
	assert.equal(blocked.size(), 0);
});

test("a call that left does not run on a later detachAll", () => {
	const blocked = createBlockedCalls();
	const reasons: DetachReason[] = [];
	const leave = blocked.enter((reason) => reasons.push(reason));
	leave();
	assert.equal(blocked.size(), 0);
	assert.equal(blocked.detachAll("abort"), 0);
	assert.deepEqual(reasons, []);
});

test("detachAll on an empty tracker returns 0", () => {
	assert.equal(createBlockedCalls().detachAll("abort"), 0);
});

test("leave called twice is harmless", () => {
	const blocked = createBlockedCalls();
	const leave = blocked.enter(() => {});
	blocked.enter(() => {});
	leave();
	leave();
	assert.equal(blocked.size(), 1);
});

test("a callback that leaves during detachAll does not break the sweep", () => {
	const blocked = createBlockedCalls();
	let calls = 0;
	const leave = blocked.enter(() => {
		calls++;
		leave();
	});
	blocked.enter(() => calls++);
	assert.equal(blocked.detachAll("user-input"), 2);
	assert.equal(calls, 2);
});

test("shouldDetachOnInput is true only for interactive steer", () => {
	assert.equal(shouldDetachOnInput({ source: "interactive", streamingBehavior: "steer" }), true);
	assert.equal(shouldDetachOnInput({ source: "interactive", streamingBehavior: "followUp" }), false);
	assert.equal(shouldDetachOnInput({ source: "rpc", streamingBehavior: "steer" }), false);
	assert.equal(shouldDetachOnInput({ source: "interactive" }), false);
});
