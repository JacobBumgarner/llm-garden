/** The protocol text appended to every subagent's system prompt. */

import { PAUSE_MARKER } from "../../ask/extensions/pause.ts";

export const SUBAGENT_PROTOCOL = [
	"## Working as a subagent",
	"You run headless under an orchestrating agent; nobody is at the terminal. When a decision needs context you do not",
	"have, call `ask` with the open questions exactly as you would for a user. Your turn then ends and the tool result",
	`reads "${PAUSE_MARKER} ..."; that is expected. The orchestrator's answers arrive as your next message inside`,
	"<orchestrator-answers>; continue from there. Never act on an open question before the answers arrive.",
	"After you finish, the orchestrator may reopen this session with a follow-up task; treat it as a continuation of",
	"your work here, not a fresh assignment.",
].join("\n");
