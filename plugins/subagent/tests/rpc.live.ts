import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegateClient } from "../extensions/rpc.ts";

test("a real pi child answers a prompt and settles", { timeout: 120_000 }, async () => {
	const client = new DelegateClient({
		args: [
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-mcp",
			"--no-prompt-templates",
			"--no-themes",
			"--model",
			"lilly-code/claude-lillypod-glm[1m]",
		],
		cwd: process.cwd(),
		command: "pi",
	});
	const types: string[] = [];
	const settled = new Promise<void>((resolve) => {
		client.onEvent((ev) => {
			types.push(ev.type);
			if (ev.type === "agent_settled") resolve();
		});
	});
	try {
		await client.start();
		await client.prompt("reply with the single word pong");
		await settled;
		const messages = await client.getMessages();
		const last = [...messages].reverse().find((m) => m.role === "assistant") as any;
		assert.ok(last, `no assistant message, events: ${types.join(",")}`);
		const text = last.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("");
		assert.match(text.toLowerCase(), /pong/);
	} finally {
		await client.stop();
	}
});
