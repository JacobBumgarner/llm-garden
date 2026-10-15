// Flips the cmux sidebar to "Pi needs input" while a ctx.ui prompt is open.
//
// Pi emits ui_prompt_start / ui_prompt_end around every ctx.ui.select /
// confirm / input / editor / custom call. This extension forwards those to the
// cmux hook CLI the way cmux's own generated pi extension does for the kinds it
// covers: `notification` (needs-input) on start, `approval-response` (running,
// or idle when the prompt ran outside an agent turn) on end.
//
// Complements cmux-session.ts without editing it. If that file is marker v4 or
// newer, cmux already patches select/confirm/input itself, so only the kinds it
// misses (custom, editor) are handled here.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PromptKind = "select" | "confirm" | "input" | "editor" | "custom";

interface UIPromptEvent {
  type: "ui_prompt_start" | "ui_prompt_end";
  kind: PromptKind;
}

interface OpenPrompt {
  sessionId: string;
  cwd: string;
  turnId: string;
  idleDialog: boolean;
  target: string[];
}

const HOOK_TIMEOUT_MS = 5_000;
const KINDS_PATCHED_BY_CMUX_V4 = new Set<PromptKind>(["select", "confirm", "input"]);

function hooksDisabled(): boolean {
  return process.env.CMUX_PI_HOOKS_DISABLED === "1";
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function surfaceTarget(): string[] | null {
  const surface = trimmed(process.env.CMUX_SURFACE_ID);
  if (!surface) return null;
  const workspace = trimmed(process.env.CMUX_WORKSPACE_ID);
  return [...(workspace ? ["--workspace", workspace] : []), "--surface", surface];
}

function cmuxBinary(): string {
  return trimmed(process.env.CMUX_PI_CMUX_BIN) || trimmed(process.env.CMUX_BUNDLED_CLI_PATH) || "cmux";
}

/** Marker version of the cmux-generated sibling extension, or 0 if absent. */
function cmuxSessionExtensionVersion(): number {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "cmux-session.ts");
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 200);
    const match = /cmux-pi-session-extension-marker v(\d+)/.exec(head);
    if (match) return Number(match[1]);
  } catch {}
  return 0;
}

function runHook(subcommand: string, target: string[], cwd: string, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmuxBinary(), ["hooks", "pi", subcommand, ...target], {
        cwd,
        env: process.env,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);
    child.once("error", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.stdin.end(JSON.stringify(payload));
  });
}

// cmux classifies the notification by this exact body (its own generated
// extension sends the same marker) and localizes the visible text itself. A
// free-text message such as "Waiting for input: ..." leaves the lifecycle at
// `running`, so the sidebar never shows needs-input for a custom prompt.
const NEEDS_INPUT_MESSAGE = "needs_input";

export default function cmuxNeedsInput(pi: ExtensionAPI) {
  const skipKinds = cmuxSessionExtensionVersion() >= 4 ? KINDS_PATCHED_BY_CMUX_V4 : new Set<PromptKind>();
  let open: OpenPrompt | undefined;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task, task);
  };

  pi.on("ui_prompt_start", (event: UIPromptEvent, ctx: ExtensionContext) => {
    if (hooksDisabled() || !ctx.hasUI || skipKinds.has(event.kind) || open) return;
    const sessionId = trimmed(ctx.sessionManager.getSessionId());
    const target = surfaceTarget();
    if (!sessionId || !target) return;
    const prompt: OpenPrompt = {
      sessionId,
      cwd: trimmed(ctx.cwd) || process.cwd(),
      turnId: `ui-prompt-${Date.now()}`,
      idleDialog: ctx.isIdle(),
      target,
    };
    open = prompt;
    enqueue(() => runHook("notification", prompt.target, prompt.cwd, {
      session_id: prompt.sessionId,
      cwd: prompt.cwd,
      hook_event_name: "questionAsked",
      event: "questionAsked",
      message: NEEDS_INPUT_MESSAGE,
      notification: { type: "question" },
      turn_id: prompt.turnId,
    }));
  });

  pi.on("ui_prompt_end", (_event: UIPromptEvent, _ctx: ExtensionContext) => {
    const prompt = open;
    open = undefined;
    if (!prompt || hooksDisabled()) return;
    enqueue(() => runHook("approval-response", prompt.target, prompt.cwd, {
      session_id: prompt.sessionId,
      cwd: prompt.cwd,
      turn_id: prompt.turnId,
      cmux_pi_idle_dialog: prompt.idleDialog,
    }));
  });
}
