import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAlias } from "../model-alias.ts";

test("a table hit returns the short name", () => {
	assert.equal(modelAlias("claude-sonnet-5-5"), "sonnet 5.5");
	assert.equal(modelAlias("claude-lillypod-glm[1m]"), "glm");
});

test("an unknown id drops the claude prefix, the 1m suffix, and dots the version", () => {
	assert.equal(modelAlias("claude-haiku-9-2"), "haiku 9.2");
	assert.equal(modelAlias("claude-newthing[1m]"), "newthing");
	assert.equal(modelAlias("gpt-x"), "gpt-x");
});
