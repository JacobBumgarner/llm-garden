import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { COPIED_MS, CopyFeedback } from "../copy-feedback.ts";

function setup() {
	let now = 1000;
	const copied: string[] = [];
	let renders = 0;
	const feedback = new CopyFeedback({ requestRender: () => renders++, copy: (t) => copied.push(t), now: () => now });
	return { feedback, copied, renders: () => renders, advance: (ms: number) => (now += ms) };
}

describe("CopyFeedback", () => {
	test("copies, reads active for COPIED_MS, then asks for a redraw", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const { feedback, copied, renders, advance } = setup();
			assert.equal(feedback.active(), false);
			feedback.copy("hello");
			assert.deepEqual(copied, ["hello"]);
			assert.equal(feedback.active(), true);
			advance(COPIED_MS - 1);
			assert.equal(feedback.active(), true);
			advance(1);
			assert.equal(feedback.active(), false);
			mock.timers.tick(COPIED_MS);
			assert.equal(renders(), 1);
		} finally {
			mock.timers.reset();
		}
	});

	test("ignores an empty string", () => {
		const { feedback, copied } = setup();
		feedback.copy("");
		assert.deepEqual(copied, []);
		assert.equal(feedback.active(), false);
	});

	test("a second copy replaces the pending redraw, and dispose cancels it", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const { feedback, renders } = setup();
			feedback.copy("a");
			mock.timers.tick(COPIED_MS - 100);
			feedback.copy("b");
			mock.timers.tick(COPIED_MS - 100);
			assert.equal(renders(), 0, "the first timer was cleared");
			feedback.dispose();
			mock.timers.tick(COPIED_MS);
			assert.equal(renders(), 0, "dispose cleared the second");
		} finally {
			mock.timers.reset();
		}
	});

	test("defaults to the OSC 52 write against the terminal", () => {
		const written: string[] = [];
		const feedback = new CopyFeedback({ requestRender: () => {}, terminal: { write: (d) => written.push(d) } });
		feedback.copy("hi");
		feedback.dispose();
		assert.ok(written.join("").includes("]52;"), written.join(""));
	});
});
