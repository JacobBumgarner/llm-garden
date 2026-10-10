import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { badgeText, composeTopBorder, HEAD, hitsBadge, parseLive, TAIL } from "../extensions/layout.ts";

/** Slice by column, one column per code point. */
const cols = (text: string, start: number, end?: number) => [...text].slice(start, end).join("");

const LONG_NAME = "a very long session name ".repeat(8).trim();

test("badgeText is empty at zero and pads the count and lambda otherwise", () => {
	assert.equal(badgeText(0), "");
	assert.equal(badgeText(1), " 1 λ ");
	assert.equal(badgeText(5), " 5 λ ");
});

test("badgeText adds a question mark while paused and stays empty at zero", () => {
	assert.equal(badgeText(2, true), " 2 λ ? ");
	assert.equal(badgeText(2, false), " 2 λ ");
	assert.equal(badgeText(0, true), "");
});

test("parseLive sets the paused flag for a mix of running and paused runs only", () => {
	const run = (state: string) => ({ id: state, agent: "a", label: "l", state });
	assert.deepEqual(parseLive({ count: 2, runs: [run("running"), run("paused")] }), { count: 2, paused: true });
	assert.deepEqual(parseLive({ count: 2, runs: [run("running"), run("queued")] }), { count: 2, paused: false });
	assert.deepEqual(parseLive({ count: 0, runs: [] }), { count: 0, paused: false });
	assert.deepEqual(parseLive(undefined), { count: 0, paused: false });
});

const rule = (n: number) => "─".repeat(n);

for (const width of [40, 80, 120]) {
	test(`the border line at width ${width} puts the badge after the head and truncates the name first`, () => {
		const { line, badge } = composeTopBorder(rule(width), width, LONG_NAME, { count: 3, paused: false });
		assert.equal(visibleWidth(line), width);
		assert.deepEqual(badge, { start: HEAD, end: HEAD + visibleWidth(badgeText(3)) });
		assert.equal(cols(line, 0, HEAD), rule(HEAD));
		assert.equal(cols(line, HEAD, badge.end), badgeText(3));
		const after = cols(line, badge.end, width - TAIL);
		assert.match(after, /^─+ a very.*… $/);
		assert.equal(cols(line, width - TAIL), rule(TAIL));
	});
}

test("the span sits at the left for both badge forms", () => {
	const plain = composeTopBorder(rule(60), 60, "n", { count: 2, paused: false });
	assert.deepEqual(plain.badge, { start: 2, end: 7 });
	const paused = composeTopBorder(rule(60), 60, "n", { count: 2, paused: true });
	assert.deepEqual(paused.badge, { start: 2, end: 9 });
	assert.equal(cols(paused.line, 2, 9), " 2 λ ? ");
});

test("the line is head, badge, fill, name, tail at exact widths", () => {
	assert.equal(
		composeTopBorder(rule(30), 30, "my session", { count: 2, paused: false }).line,
		`${rule(2)} 2 λ ${rule(9)} my session ${rule(2)}`,
	);
	assert.equal(
		composeTopBorder(rule(30), 30, undefined, { count: 2, paused: true }).line,
		`${rule(2)} 2 λ ? ${rule(21)}`,
	);
	assert.equal(
		composeTopBorder(rule(20), 20, "my session", { count: 1, paused: false }).line,
		`${rule(2)} 1 λ ${rule(6)} my… ${rule(2)}`,
	);
});

test("a zero count draws the name alone and no badge span", () => {
	const { line, badge } = composeTopBorder(rule(80), 80, "my session", { count: 0, paused: false });
	assert.equal(badge, undefined);
	assert.equal(line, `${rule(80 - 2 - 12)} my session ${rule(TAIL)}`);
});

test("the badge draws without a name", () => {
	const alone = composeTopBorder(rule(40), 40, undefined, { count: 1, paused: false });
	assert.deepEqual(alone.badge, { start: HEAD, end: HEAD + 5 });
	assert.equal(alone.line, `${rule(2)} 1 λ ${rule(33)}`);
});

test("a narrow border drops the name first and then the badge", () => {
	const badgeOnly = composeTopBorder(rule(12), 12, "name", { count: 1, paused: false });
	assert.deepEqual(badgeOnly.badge, { start: 2, end: 7 });
	assert.equal(badgeOnly.line, `${rule(2)} 1 λ ${rule(5)}`);
	const exact = composeTopBorder(rule(9), 9, "name", { count: 1, paused: false });
	assert.equal(exact.line, `${rule(2)} 1 λ ${rule(2)}`);
	const tooNarrow = composeTopBorder(rule(8), 8, "name", { count: 1, paused: false });
	assert.equal(tooNarrow.badge, undefined);
	assert.equal(tooNarrow.line, rule(8));
});

const TAGS = {
	badge: (text: string) => `<b>${text}</b>`,
	warning: (text: string) => `<w>${text}</w>`,
	name: (text: string) => `<n>${text}</n>`,
	border: (text: string) => `<t>${text}</t>`,
};

test("a paused badge takes the warning paint and spans the whole badge", () => {
	const { line, badge } = composeTopBorder(rule(40), 40, "n", { count: 1, paused: true }, TAGS);
	assert.match(line, /^─{2}<w> 1 λ \? <\/w>─+<n> n <\/n><t>──<\/t>$/);
	assert.ok(badge);
	assert.equal(badge.end - badge.start, visibleWidth(" 1 λ ? "));
	const plain = composeTopBorder(rule(40), 40, "n", { count: 1, paused: false });
	assert.equal(plain.badge && plain.badge.end - plain.badge.start, visibleWidth(" 1 λ "));
});

test("paints wrap each segment", () => {
	const { line } = composeTopBorder(rule(40), 40, "n", { count: 1, paused: false }, TAGS);
	assert.match(line, /^─{2}<b> 1 λ <\/b>─+<n> n <\/n><t>──<\/t>$/);
});

test("a click hits only on the top row inside the span", () => {
	const span = { start: 10, end: 15 };
	assert.equal(hitsBadge(span, 10, 0), true);
	assert.equal(hitsBadge(span, 14, 0), true);
	assert.equal(hitsBadge(span, 9, 0), false);
	assert.equal(hitsBadge(span, 15, 0), false);
	assert.equal(hitsBadge(span, 12, 1), false);
	assert.equal(hitsBadge(undefined, 12, 0), false);
});
