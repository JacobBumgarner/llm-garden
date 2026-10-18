import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOutside, outsideClickListener, parsePresses } from "../outside-click.ts";

const press = (x: number, y: number, button = 0) => `\x1b[<${button};${x + 1};${y + 1}M`;
const bounds = { row: 1, col: 50, width: 40, height: 20 };

describe("parsePresses", () => {
	it("reads a left press as a zero-based cell", () => {
		assert.deepEqual(parsePresses(press(10, 5)), [{ x: 10, y: 5 }]);
	});

	it("finds every press in a chunk that holds several sequences", () => {
		assert.deepEqual(parsePresses(`${press(1, 1)}\x1b[<0;2;2m${press(3, 3)}`), [
			{ x: 1, y: 1 },
			{ x: 3, y: 3 },
		]);
	});

	it("ignores releases, drags, wheel, other buttons, and keys", () => {
		assert.deepEqual(parsePresses("\x1b[<0;11;6m"), []);
		assert.deepEqual(parsePresses(press(10, 5, 32)), []);
		assert.deepEqual(parsePresses(press(10, 5, 64)), []);
		assert.deepEqual(parsePresses(press(10, 5, 2)), []);
		assert.deepEqual(parsePresses("\x1b/"), []);
		assert.deepEqual(parsePresses("a"), []);
	});
});

describe("isOutside", () => {
	it("is false inside and on the edges, true past them", () => {
		assert.equal(isOutside({ x: 50, y: 1 }, bounds), false);
		assert.equal(isOutside({ x: 89, y: 20 }, bounds), false);
		assert.equal(isOutside({ x: 49, y: 5 }, bounds), true);
		assert.equal(isOutside({ x: 90, y: 5 }, bounds), true);
		assert.equal(isOutside({ x: 60, y: 0 }, bounds), true);
		assert.equal(isOutside({ x: 60, y: 21 }, bounds), true);
	});
});

describe("outsideClickListener", () => {
	it("fires on a press outside the bounds, from a string or a Buffer", () => {
		let fired = 0;
		const listen = outsideClickListener(
			() => bounds,
			() => void fired++,
		);
		listen(press(5, 5));
		assert.equal(fired, 1);
		listen(press(60, 5));
		assert.equal(fired, 1);
		listen("x");
		assert.equal(fired, 1);
		listen(Buffer.from(press(5, 5)));
		assert.equal(fired, 2);
	});

	it("does nothing while the overlay reports no bounds", () => {
		let fired = 0;
		const listen = outsideClickListener(
			() => undefined,
			() => void fired++,
		);
		listen(press(5, 5));
		assert.equal(fired, 0);
	});
});
