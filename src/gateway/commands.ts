import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { getSessionId, clearSessionId } from "../agent/session.js";
import { buildSystemPrompt } from "../memory/loader.js";

export interface CommandResult {
  handled: boolean;
  response?: string;
}

export async function handleCommand(
  text: string,
  phone: string,
): Promise<CommandResult> {
  const trimmed = text.trim().toLowerCase();

  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const [cmd, ...args] = trimmed.split(/\s+/);

  switch (cmd) {
    case "/ping":
      return { handled: true, response: "pong" };

    case "/status":
      return { handled: true, response: await statusCommand(phone) };

    case "/reset":
      return { handled: true, response: await resetCommand(phone) };

    case "/memory":
      return { handled: true, response: await memoryCommand() };

    case "/reload":
      return { handled: true, response: "System prompt will reload on next message." };

    case "/quiet":
      return { handled: true, response: `quiet toggle received (phone: ${phone})` };

    default:
      return { handled: false };
  }
}

async function statusCommand(phone: string): Promise<string> {
  const sessionId = await getSessionId(phone);
  let state: Record<string, unknown> = {};
  try {
    const raw = await readFile(config.paths.statePath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    // no state file yet
  }

  const lines = [
    "--- JuneClaw Status ---",
    `Session: ${sessionId ?? "none"}`,
    `PID: ${state.pid ?? "unknown"}`,
    `Started: ${state.startedAt ?? "unknown"}`,
    `Workspace: ${config.workspace}`,
  ];
  return lines.join("\n");
}

async function resetCommand(phone: string): Promise<string> {
  const sessionId = await getSessionId(phone);
  if (sessionId) {
    // Write HANDOFF.md so next session picks up context
    const handoff = `# Handoff\n\nPrevious session ${sessionId} was reset at ${new Date().toISOString()}.\nReview recent daily logs for context.\n`;
    const { join } = await import("node:path");
    await writeFile(join(config.workspace, "HANDOFF.md"), handoff, "utf-8");
    await clearSessionId(phone);
    return `Session cleared. HANDOFF.md written. Next message starts fresh.`;
  }
  return "No active session to reset.";
}

async function memoryCommand(): Promise<string> {
  const prompt = await buildSystemPrompt("system", config.channels.june.name);
  const charCount = prompt.length;
  const lineCount = prompt.split("\n").length;
  return `System prompt: ${charCount} chars, ${lineCount} lines`;
}
