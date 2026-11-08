import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dropCoveredImages, imageSpan, isImageLine, shieldImages } from "../image-shield.ts";

const kitty = (rows: number) => `\x1b_Ga=T,f=100,q=2,C=1,c=20,r=${rows},i=7;AAAA\x1b\\`;
const iterm = (rows: number) => `${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b]1337;File=inline=1;size=4:AAAA\x07`;

describe("imageSpan", () => {
	it("reads a Kitty image's rows downward from the anchor", () => {
		assert.deepEqual(imageSpan(kitty(6)), { from: 0, to: 6 });
	});
	it("reads an iTerm2 image's rows upward from its cursor move", () => {
		assert.deepEqual(imageSpan(iterm(4)), { from: -3, to: 1 });
		assert.deepEqual(imageSpan(iterm(1)), { from: 0, to: 1 });
	});
});

describe("dropCoveredImages", () => {
	const rect = [{ row: 5, height: 3 }];

	it("blanks a Kitty image whose rows reach an overlay, and keeps one that stops short", () => {
		const lines = ["a", kitty(5), "", "", "", "", "b", "c", "d", "e"];
		const out = dropCoveredImages(lines, rect, lines.length);
		assert.equal(out[1], "");
		const short = ["a", kitty(4), "", "", "", "x", "b", "c", "d", "e"];
		assert.equal(dropCoveredImages(short, rect, short.length)[1], kitty(4));
	});

	it("blanks an iTerm2 image anchored below an overlay that reaches up into it", () => {
		const lines = ["", "", "", "", "", "", "", iterm(3), "", ""];
		assert.equal(dropCoveredImages(lines, rect, lines.length)[7], "");
	});

	it("measures rows from the viewport when the frame is taller than the terminal", () => {
		const lines = ["old", "old", "a", kitty(2), "", "b", "c", "d", "e", "f"];
		const out = dropCoveredImages(lines, [{ row: 1, height: 2 }], 8);
		assert.equal(out[3], "");
	});

	it("leaves text and uncovered images alone with no overlays", () => {
		const lines = ["a", kitty(9)];
		assert.equal(dropCoveredImages(lines, [], 2), lines);
	});
});

describe("shieldImages", () => {
	function fakeTui() {
		const calls: string[] = [];
		return {
			calls,
			renderedOverlayLayouts: [{ row: 0, height: 2 }],
			compositeOverlays(lines: string[]) {
				calls.push("overlays");
				return lines;
			},
			compositeLineAt(base: string, overlay: string) {
				calls.push(`line:${isImageLine(base) ? "image" : base}`);
				return overlay;
			},
		};
	}

	it("wraps compositing while held and restores it after the last release", () => {
		const tui = fakeTui();
		const original = tui.compositeOverlays;
		const releaseA = shieldImages(tui);
		const releaseB = shieldImages(tui);
		assert.notEqual(tui.compositeOverlays, original);
		assert.deepEqual(tui.compositeOverlays(["x", kitty(3), "", ""], 80, 4), ["x", "", "", ""]);
		tui.compositeLineAt(kitty(1), "o", 0, 1, 80);
		assert.deepEqual(tui.calls, ["overlays", "line:"]);
		releaseA();
		releaseA();
		assert.notEqual(tui.compositeOverlays, original);
		releaseB();
		assert.equal(tui.compositeOverlays, original);
	});

	it("ignores a TUI without the compositing members", () => {
		const bare = { requestRender() {} };
		assert.doesNotThrow(() => shieldImages(bare)());
	});
});
