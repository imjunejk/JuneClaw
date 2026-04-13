import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, type TaskType } from "../config.js";
import { getSessionId, clearSessionId, getSessionEntries } from "../agent/session.js";
import { setForceTaskType } from "../agent/classifier.js";
import { buildSystemPrompt } from "../memory/loader.js";
import { listJobs } from "../scheduler/cron.js";
import { listAgentStatus, cascadeKill } from "../agent/subagents.js";
import { writeHandoff } from "../memory/handoff.js";

const execFileAsync = promisify(execFile);

const ALGO_DIR = join(homedir(), "gwangsu", "algo");
const TRADE_EXECUTOR = join(ALGO_DIR, "trade_executor.py");
const ALGO_PYTHON = join(ALGO_DIR, ".venv", "bin", "python");

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

    // /quiet is handled in daemon.ts before reaching here

    case "/cron":
      return { handled: true, response: await cronCommand(args) };

    case "/agents":
      return { handled: true, response: await agentsCommand(args) };

    case "/bypass":
      return { handled: true, response: await bypassCommand() };

    case "/trade":
      return { handled: true, response: await tradeCommand(args) };

    case "/execute":
      return { handled: true, response: await executeCommand(args) };

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
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const lastActive = new Date(entry.lastActiveAt).toLocaleTimeString("en-US", {
      timeZone: config.timezone,
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
      "claude", "--permission-mode", config.claude.permissionMode,
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

// ── Trade Execution ──────────────────────────────────────

async function runTradeExecutor(...cmdArgs: string[]): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    const { stdout } = await execFileAsync(ALGO_PYTHON, [TRADE_EXECUTOR, ...cmdArgs], {
      timeout: 15_000,
      env: { ...process.env, PYTHONPATH: ALGO_DIR },
    });
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return { ok: false, error: `trade_executor 응답 파싱 실패: ${stdout.slice(0, 200)}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return { ok: false, error: "trade_executor.py 또는 Python venv를 찾을 수 없음" };
    }
    return { ok: false, error: msg };
  }
}

async function tradeCommand(args: string[]): Promise<string> {
  // /trade XLE sell 10%
  // /trade XLE sell all
  // /trade IWM buy $500
  if (args.length < 3) {
    return [
      "사용법:",
      "  /trade XLE sell 10%     — XLE 10% 매도",
      "  /trade XLE sell all     — XLE 전량 매도",
      "  /trade IWM buy $500     — IWM $500 매수",
    ].join("\n");
  }

  const symbol = args[0].toUpperCase();
  const side = args[1];
  const amountStr = args[2];

  if (side !== "buy" && side !== "sell") {
    return `❌ side는 buy 또는 sell만 가능 (입력: ${side})`;
  }

  const cmdArgs = ["trade", "--symbol", symbol, "--side", side];

  if (side === "sell") {
    if (amountStr === "all" || amountStr === "close") {
      cmdArgs.push("--close");
    } else if (amountStr.endsWith("%")) {
      const pct = parseFloat(amountStr.replace("%", ""));
      if (isNaN(pct) || pct <= 0 || pct > 100) {
        return `❌ 퍼센트 범위: 1-100 (입력: ${amountStr})`;
      }
      cmdArgs.push("--percent", String(pct));
    } else {
      return `❌ sell에는 퍼센트(10%) 또는 all 필요 (입력: ${amountStr})`;
    }
  } else {
    // buy
    const notional = parseFloat(amountStr.replace("$", ""));
    if (isNaN(notional) || notional <= 0) {
      return `❌ 매수 금액은 양수 (입력: ${amountStr})`;
    }
    cmdArgs.push("--notional", String(notional));
  }

  const result = await runTradeExecutor(...cmdArgs);

  if (result.ok) {
    return `✅ ${result.action}`;
  }
  return `❌ 주문 실패: ${result.error}`;
}

async function executeCommand(args: string[]): Promise<string> {
  // /execute 1,2  or  /execute 1
  if (args.length === 0) {
    // 보류 액션 목록 표시
    const pending = await runTradeExecutor("actions", "get");
    if (!pending.ok) return `❌ ${pending.error}`;

    const actions = (pending.actions ?? []) as Array<{ id: number; desc: string }>;
    if (actions.length === 0) {
      return pending.expired
        ? "⏰ 실행 가능 액션 만료 (24시간 경과)"
        : "📭 실행 대기 중인 액션 없음";
    }

    const lines = ["🎯 실행 가능 액션:"];
    for (const a of actions) {
      lines.push(`[${a.id}] ${a.desc}`);
    }
    lines.push('\n"/execute 1,2" 로 실행');
    return lines.join("\n");
  }

  // 실행
  const idsStr = args.join(",").replace(/,+/g, ",").replace(/^,|,$/g, "");
  const result = await runTradeExecutor("actions", "execute", idsStr);

  if (!result.ok) return `❌ ${result.error}`;

  const results = (result.results ?? []) as Array<{ id: number; ok: boolean; action?: string; error?: string }>;
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok) {
      lines.push(`✅ [${r.id}] ${r.action}`);
    } else {
      lines.push(`❌ [${r.id}] ${r.error}`);
    }
  }
  return lines.join("\n");
}
