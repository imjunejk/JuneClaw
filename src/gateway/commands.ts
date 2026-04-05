import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, type TaskType } from "../config.js";
import { getSessionId, clearSessionId, getSessionEntries } from "../agent/session.js";
import { setForceTaskType } from "../agent/classifier.js";
import { buildSystemPrompt } from "../memory/loader.js";
import { listJobs } from "../scheduler/cron.js";
import { listAgentStatus, cascadeKill } from "../agent/subagents.js";
import { writeHandoff } from "../memory/handoff.js";

const execFileAsync = promisify(execFile);

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

    case "/sessions":
      return { handled: true, response: await sessionsCommand(phone) };

    case "/reset":
      return { handled: true, response: await resetCommand(phone, args) };

    case "/force":
      return { handled: true, response: forceCommand(args) };

    case "/model":
      return { handled: true, response: modelCommand() };

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

    case "/bypass":
      return { handled: true, response: await bypassCommand() };

    default:
      return { handled: false };
  }
}

async function statusCommand(phone: string): Promise<string> {
  let state: Record<string, unknown> = {};
  try {
    const raw = await readFile(config.paths.statePath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    // no state file yet
  }

  const entries = await getSessionEntries(phone);
  const sessionLines: string[] = [];
  for (const [type, entry] of Object.entries(entries)) {
    const age = Math.round((Date.now() - new Date(entry.lastActiveAt).getTime()) / 60_000);
    sessionLines.push(`  ${type}: ${entry.model} (${entry.messageCount} msgs, ${age}min ago)`);
  }

  const lines = [
    "--- JuneClaw Status ---",
    `PID: ${state.pid ?? "unknown"}`,
    `Started: ${state.startedAt ?? "unknown"}`,
    `Workspace: ${config.workspace}`,
    "",
    "--- Active Sessions ---",
    sessionLines.length > 0 ? sessionLines.join("\n") : "  (none)",
  ];
  return lines.join("\n");
}

async function sessionsCommand(phone: string): Promise<string> {
  const entries = await getSessionEntries(phone);
  if (Object.keys(entries).length === 0) {
    return "No active sessions.";
  }

  const lines = ["--- Session Pool ---"];
  for (const [type, entry] of Object.entries(entries)) {
    const created = new Date(entry.createdAt).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const lastActive = new Date(entry.lastActiveAt).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const idleMin = Math.round((Date.now() - new Date(entry.lastActiveAt).getTime()) / 60_000);
    const timeout = config.sessionPool.idleTimeouts[type as TaskType];
    const timeoutMin = timeout > 0 ? `${timeout / 60_000}min` : "none";

    lines.push(`${type}:`);
    lines.push(`  Model: ${entry.model}`);
    lines.push(`  Session: ${entry.sessionId.slice(0, 12)}...`);
    lines.push(`  Messages: ${entry.messageCount}`);
    lines.push(`  Created: ${created} | Last: ${lastActive} (${idleMin}min idle)`);
    lines.push(`  Timeout: ${timeoutMin}`);
  }
  return lines.join("\n");
}

async function resetCommand(phone: string, args: string[]): Promise<string> {
  // /reset coding — reset specific session type
  const taskType = args[0] as TaskType | undefined;
  const validTypes: TaskType[] = ["coding", "research", "general", "quick"];

  if (taskType && validTypes.includes(taskType)) {
    const sessionId = await getSessionId(phone, taskType);
    if (sessionId) {
      await clearSessionId(phone, taskType);
      return `${taskType} session cleared. Next ${taskType} message starts fresh.`;
    }
    return `No active ${taskType} session.`;
  }

  // /reset — reset all sessions
  const entries = await getSessionEntries(phone);
  const types = Object.keys(entries);
  if (types.length > 0) {
    await writeHandoff({
      reason: "manual reset via /reset command",
      progress: `Sessions reset: ${types.join(", ")}`,
      nextAction: "Review recent daily logs for context.",
    });
    await clearSessionId(phone);
    return `All sessions cleared (${types.join(", ")}). HANDOFF.md written.`;
  }
  return "No active sessions to reset.";
}

function forceCommand(args: string[]): string {
  const validTypes: TaskType[] = ["coding", "research", "general", "quick"];
  const type = args[0] as TaskType | undefined;

  if (!type || !validTypes.includes(type)) {
    return `Usage: /force <${validTypes.join("|")}>\nForces the next message to use the specified task type.`;
  }

  setForceTaskType(type);
  return `Next message will be classified as: ${type} (${config.claude.modelRouting[type]})`;
}

function modelCommand(): string {
  const { modelRouting } = config.claude;
  return [
    "--- Model Routing ---",
    `Coding:    ${modelRouting.coding}`,
    `Research:  ${modelRouting.research}`,
    `General:   ${modelRouting.general}`,
    `Quick:     ${modelRouting.quick}`,
    `Classifier: ${modelRouting.classifier}`,
    `Override (env): ${config.claude.model ?? "none"}`,
  ].join("\n");
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

async function bypassCommand(): Promise<string> {
  const sessionName = "claude-bypass";
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return `bypass 세션 이미 실행 중: tmux attach -t ${sessionName}`;
  } catch {
    // Session doesn't exist, create it
  }

  try {
    await execFileAsync("tmux", [
      "new-session", "-d", "-s", sessionName,
      "-c", config.projectDir,
      "claude", "--dangerously-skip-permissions",
    ]);
    return `bypass 세션 생성 완료: tmux attach -t ${sessionName}`;
  } catch (err) {
    return `bypass 세션 생성 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
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
