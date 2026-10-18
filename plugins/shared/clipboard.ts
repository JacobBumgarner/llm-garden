/**
 * Put text on the system clipboard: through the native helper when pi has one
 * for this platform, else by an OSC 52 write, which most terminals honor.
 */

import { getNativeClipboard } from "@earendil-works/pi-tui";

export interface ClipboardTerminal {
	write(data: string): void;
}

export async function copyToClipboard(text: string, terminal: ClipboardTerminal): Promise<void> {
	const native = getNativeClipboard();
	if (native?.setText) {
		try {
			await native.setText(text);
			return;
		} catch {
			// Fall through to OSC 52.
		}
	}
	terminal.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}
