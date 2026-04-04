import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { getSessionId, clearSessionId } from "../agent/session.js";
import { buildSystemPrompt } from "../memory/loader.js";
import { listJobs } from "../scheduler/cron.js";
import { listAgentStatus, cascadeKill } from "../agent/subagents.js";
import { writeHandoff } from "../memory/handoff.js";

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

    case "/cron":
      return { handled: true, response: await cronCommand(args) };

    case "/agents":
      return { handled: true, response: await agentsCommand(args) };

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
    await writeHandoff({
      reason: "manual reset via /reset command",
      progress: `Session ${sessionId} reset by user.`,
      nextAction: "Review recent daily logs for context.",
    });
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

async function cronCommand(args: string[]): Promise<string> {
  if (args.length === 0 || args[0] === "list") {
    const jobs = listJobs();
    if (jobs.length === 0) return "No cron jobs registered.";
    const lines = jobs.map(
      (j) => `  ${j.name}: ${j.schedule} (${j.running ? "running" : "stopped"})`,
    );
    return `Cron jobs:\n${lines.join("\n")}`;
  }

  return "Usage: /cron [list]";
}

async function agentsCommand(args: string[]): Promise<string> {
  if (args.length === 0 || args[0] === "list" || args[0] === "status") {
    const status = await listAgentStatus();
    return status || "No active sub-agents.";
  }

  if (args[0] === "kill" && args[1]) {
    const result = await cascadeKill(args[1]);
    return result || `Cascade kill sent for: ${args[1]}`;
  }

  return "Usage: /agents [list|status|kill <id>]";
}
