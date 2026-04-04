import { readFile, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { getSessionId, clearSessionId } from "../agent/session.js";
import { buildSystemPrompt } from "../memory/loader.js";
import { broadcast, listReportTypes, listRecipients } from "./broadcast.js";
import { listJobs } from "../scheduler/cron.js";
import { runAlgoScript, listScripts } from "../algo/runner.js";

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

    case "/broadcast":
      return { handled: true, response: await broadcastCommand(args) };

    case "/cron":
      return { handled: true, response: await cronCommand(args) };

    case "/algo":
      return { handled: true, response: await algoCommand(args) };

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

async function broadcastCommand(args: string[]): Promise<string> {
  // /broadcast <reportType> <message>
  // /broadcast list — show report types
  // /broadcast recipients [type] — show recipients
  if (args.length === 0 || args[0] === "help") {
    return "Usage: /broadcast <type> <message>\n/broadcast list\n/broadcast recipients [type]";
  }

  if (args[0] === "list") {
    const types = await listReportTypes();
    const lines = Object.entries(types).map(([k, v]) => `  ${k}: ${v}`);
    return `Report types:\n${lines.join("\n")}`;
  }

  if (args[0] === "recipients") {
    const recipients = await listRecipients(args[1]);
    const lines = recipients.map(
      (r) => `  ${r.name} (${r.target}) — ${r.reports.join(", ")}`,
    );
    return `Recipients:\n${lines.join("\n")}`;
  }

  const reportType = args[0]!;
  const message = args.slice(1).join(" ");
  if (!message) {
    return "Missing message. Usage: /broadcast <type> <message>";
  }

  const sent = await broadcast(reportType, message);
  return `Broadcast sent to ${sent.length}: ${sent.join(", ")}`;
}

async function cronCommand(args: string[]): Promise<string> {
  // /cron — list jobs
  // /cron list — list jobs
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

async function algoCommand(args: string[]): Promise<string> {
  // /algo <script> — run a script
  // /algo list — list available scripts
  if (args.length === 0 || args[0] === "help") {
    return `Usage: /algo <script>\n/algo list\nAvailable: ${listScripts().join(", ")}`;
  }

  if (args[0] === "list") {
    return `Available algo scripts: ${listScripts().join(", ")}`;
  }

  const name = args[0]!;
  const result = await runAlgoScript(name);

  if (result.error) {
    return `Algo ${name} failed: ${result.error}`;
  }

  const output = result.output.slice(0, 3000);
  return `Algo ${name} output:\n${output}`;
}
