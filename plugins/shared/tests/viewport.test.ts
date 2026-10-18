import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clamp } from "../clamp.ts";
import { Viewport, viewportTop, WHEEL_LINES } from "../viewport.ts";

describe("viewportTop", () => {
	it("pins to the end and clamps manual offsets", () => {
		assert.equal(viewportTop(50, 10, 0, true), 40);
		assert.equal(viewportTop(50, 10, 45, false), 40);
		assert.equal(viewportTop(50, 10, -3, false), 0);
		assert.equal(viewportTop(5, 10, 3, false), 0);
	});
});

describe("clamp", () => {
	it("limits a value to the range", () => {
		assert.equal(clamp(5, 0, 3), 3);
		assert.equal(clamp(-1, 0, 3), 0);
		assert.equal(clamp(2, 0, 3), 2);
	});
});

describe("Viewport", () => {
	function settled(): Viewport {
		const v = new Viewport();
		v.layout(50, 10);
		return v;
	}

	it("starts pinned, and layout puts the top at the end", () => {
		const v = new Viewport();
		assert.equal(v.layout(50, 10), 40);
		assert.equal(v.pinned, true);
	});

	it("maps the navigation keys and ignores the rest", () => {
		const v = settled();
		assert.equal(v.handleKey("up", 10), true);
		assert.equal(v.layout(50, 10), 39);
		assert.equal(v.pinned, false);
		v.handleKey("pageUp", 10);
		assert.equal(v.layout(50, 10), 29);
		v.handleKey("down", 10);
		assert.equal(v.layout(50, 10), 30);
		v.handleKey("pageDown", 10);
		assert.equal(v.layout(50, 10), 40);
		assert.equal(v.pinned, true, "reaching the end pins again");
		v.handleKey("home", 10);
		assert.equal(v.layout(50, 10), 0);
		v.handleKey("end", 10);
		assert.equal(v.layout(50, 10), 40);
		for (const key of ["g", "G", "x", "enter", "left"]) {
			assert.equal(v.handleKey(key, 10), false, key);
		}
		assert.equal(v.layout(50, 10), 40);
	});

	it("scrolls the wheel by one line in the delta's direction", () => {
		const v = settled();
		v.wheel(-1);
		assert.equal(v.layout(50, 10), 40 - WHEEL_LINES);
		v.wheel(5);
		assert.equal(v.layout(50, 10), 40);
		assert.equal(WHEEL_LINES, 1);
	});

	it("scrolls from an explicit top", () => {
		const v = new Viewport();
		v.top = 7;
		v.pinned = false;
		assert.equal(v.layout(50, 10), 7);
	});
});
