/**
 * Stand-in for pi-tui with the surface the view uses. Text is plain (no ANSI),
 * so width helpers work on string length. Keys match by name: the test feeds
 * `"down"` where pi would feed an escape sequence.
 */

export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
}

export interface TuiMouseEvent {
	type: "press" | "release" | "move" | "drag" | "click" | "wheel";
	button: "left" | "middle" | "right" | "none";
	x: number;
	y: number;
	screenX: number;
	screenY: number;
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	wheelDelta?: number;
	clickCount?: number;
}

export interface TuiMouseEventResult {
	handled?: boolean;
	capture?: boolean;
	focus?: boolean;
	render?: boolean;
}

export interface Focusable {
	focused: boolean;
}

export interface TUI {
	terminal: { rows: number; columns: number };
	requestRender(): void;
}

export interface EditorTheme {
	borderColor(text: string): string;
}

export type Color = { kind: "rgb"; r: number; g: number; b: number };

export function mixColors(first: Color, second: Color, amount: number): Color {
	const mix = (a: number, b: number) => Math.round(a + (b - a) * amount);
	return { kind: "rgb", r: mix(first.r, second.r), g: mix(first.g, second.g), b: mix(first.b, second.b) };
}

export function matchesKey(data: string, id: string): boolean {
	return data === id;
}

export function visibleWidth(text: string): number {
	return [...text].length;
}

export function truncateToWidth(text: string, width: number, ellipsis = "...", pad = false): string {
	const chars = [...text];
	if (chars.length <= width) return pad ? text + " ".repeat(width - chars.length) : text;
	const keep = Math.max(0, width - [...ellipsis].length);
	return chars.slice(0, keep).join("") + ellipsis;
}

export function sliceByColumn(text: string, start: number, length: number): string {
	return [...text].slice(start, start + length).join("");
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const chars = [...paragraph];
		if (chars.length === 0) lines.push("");
		for (let at = 0; at < chars.length; at += width) lines.push(chars.slice(at, at + width).join(""));
	}
	return lines;
}

export class Text {
	text: string;

	constructor(text: string, _x: number, _y: number) {
		this.text = text;
	}
}

/** Renders markdown as its raw lines, treating fences like pi: a border line per fence and an indent on code. */
interface MarkdownTheme {
	codeBlockBorder?: (text: string) => string;
	codeBlockIndent?: string;
}

export class Markdown {
	private readonly text: string;
	private readonly theme: MarkdownTheme;

	constructor(text: string, _x: number, _y: number, theme: MarkdownTheme) {
		this.text = text;
		this.theme = theme;
	}

	render(width: number): string[] {
		const out: string[] = [];
		let inCode = false;
		for (const line of this.text.split("\n")) {
			if (/^\s*(```|~~~)/.test(line)) {
				inCode = !inCode;
				out.push(this.theme.codeBlockBorder ? this.theme.codeBlockBorder("```") : "```");
				continue;
			}
			const indent = inCode ? (this.theme.codeBlockIndent ?? "  ") : "";
			out.push(...wrapTextWithAnsi(indent + line, width));
		}
		return out;
	}
}

/** A line editor that renders like pi's: a border line, the text lines, a border line. */
export class Editor {
	focused = false;
	onSubmit: ((value: string) => void) | undefined;
	private value = "";

	constructor(_tui: TUI, _theme: EditorTheme) {}

	setText(text: string): void {
		this.value = text;
	}

	getText(): string {
		return this.value;
	}

	getExpandedText(): string {
		return this.value;
	}

	insertTextAtCursor(text: string): void {
		this.value += text;
	}

	handleInput(data: string): void {
		if (data === "enter") this.onSubmit?.(this.value);
		else if (data === "shift+enter") this.value += "\n";
		else this.value += data;
	}

	render(width: number): string[] {
		const body = this.value.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
		return ["─".repeat(width), ...body, "─".repeat(width)];
	}
}
