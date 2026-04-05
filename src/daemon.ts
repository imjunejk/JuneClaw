import { writeFile, readFile, unlink, mkdir, rename } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
import { config, type ChannelConfig, type TaskType } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId, clearSessionId, cleanupExpiredSessions } from "./agent/session.js";
import { classifyTask, getModelForTask } from "./agent/classifier.js";
import { quickRespond } from "./agent/quick-responder.js";
import { recordExchange, getRecentContext, appendSharedContext, getSharedContext } from "./agent/context-bridge.js";
import { buildSystemPrompt } from "./memory/loader.js";
import { appendDailyLog, appendSystemLog } from "./memory/writer.js";
import { addJob, stopAll as stopAllCron } from "./scheduler/cron.js";
import { cascadeKill, cleanupStaleAgents, archiveCompleted } from "./agent/subagents.js";
import { writeHandoff, writeSmartHandoff } from "./memory/handoff.js";
import { emit } from "./hooks/events.js";
import { logFromError } from "./hooks/incident.js";
import {
  recordError,
  recordSuccess,
  recordMessage,
  recordContextFull,
  recordUsage,
  shouldRotate,
  shouldWarnContext,
  shouldHandoff,
  markHandoffDone,
  executeRotation,
  resetRotationState,
  getMessageCount,
  pruneStaleStates,
} from "./agent/context-rotation.js";
import {
  runWeeklyCompression,
  runMonthlyCompression,
} from "./memory/consolidation.js";
import type { Channel } from "./gateway/types.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err: unknown): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, err);
}

interface DaemonState {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string | null;
  lastLoopAt: string | null;
  channels: Record<string, { sessionId: string | null; quiet: boolean }>;
}

const state: DaemonState = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  lastLoopAt: null,
  channels: {},
};

const quietMode = new Map<string, boolean>();
let quietHoursOverrideUntil: number = 0;

const processedIds = new Set<number>();
let processing = false;
const btwQueue: string[] = [];
const pendingMessages: { text: string; taskType: TaskType }[] = [];
let monitorProcess: ChildProcess | null = null;
let monitorStopped = false;

interface ProgressState {
  startedAt: number;
  taskType: string;
  agentName: string;
  model: string;
  messagePreview: string;
  phone: string;
}

async function writeProgressState(taskType: TaskType, text: string, phone: string): Promise<void> {
  // Collapse whitespace (including newlines) so downstream shell parsers can't
  // be tripped up by multi-line previews.
  const preview = text.slice(0, 100).replace(/\s+/g, " ").trim();
  const state: ProgressState = {
    startedAt: Date.now(),
    taskType,
    agentName: config.progress.agentNames[taskType],
    model: config.claude.modelRouting[taskType],
    messagePreview: preview,
    phone,
  };
  try {
    await mkdir(dirname(config.progress.statePath), { recursive: true });
    // Atomic write: write to tmp then rename, so the monitor never sees a
    // partially-written JSON during its 5s poll.
    const tmpPath = config.progress.statePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await rename(tmpPath, config.progress.statePath);
    log(`[progress] state written: ${state.agentName} (${taskType})`);
  } catch (err) {
    log(`[progress] failed to write state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function clearProgressState(): Promise<void> {
  try {
    await unlink(config.progress.statePath);
    log("[progress] state cleared");
  } catch {
    // file may not exist
  }
}

/**
 * Wrap a long-running async task with a liveness heartbeat.
 * Updates state.lastLoopAt every 30s so the watchdog doesn't falsely detect a hang
 * while Claude CLI is legitimately running (which can take up to 10-20 minutes).
 */
async function withProcessingLiveness<T>(fn: () => Promise<T>): Promise<T> {
  const interval = setInterval(() => {
    state.lastLoopAt = new Date().toISOString();
    saveState().catch(() => {});
  }, 30_000);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

function startProgressMonitor(): void {
  monitorStopped = false;
  const scriptPath = join(dirname(new URL(import.meta.url).pathname), "..", "tools", "progress-monitor.sh");
  monitorProcess = spawn("bash", [scriptPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  monitorProcess.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(`[monitor] ${line}`);
  });

  monitorProcess.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(`[monitor:err] ${line}`);
  });

  monitorProcess.on("exit", (code) => {
    log(`[monitor] exited with code ${code}`);
    monitorProcess = null;
    // Respawn the monitor after a brief delay so progress notifications
    // aren't permanently lost if the monitor crashes.
    if (!monitorStopped) {
      setTimeout(() => {
        if (!monitorStopped && monitorProcess === null) {
          log("[monitor] respawning after crash...");
          startProgressMonitor();
        }
      }, 5000);
    }
  });

  log(`[monitor] started (PID ${monitorProcess.pid})`);
}

function stopProgressMonitor(): void {
  monitorStopped = true;
  if (monitorProcess) {
    monitorProcess.kill("SIGTERM");
    monitorProcess = null;
    log("[monitor] stopped");
  }
}

async function killDuplicateProcesses(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "JuneClaw/dist/index"]);
    const pids = stdout.trim().split("\n").map(Number).filter((p) => p !== process.pid);
    if (pids.length === 0) return;

    for (const pid of pids) {
      log(`Killing duplicate daemon process (PID ${pid})`);
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }

    // Wait for processes to actually exit (poll up to 5s)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const alive = pids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      if (alive.length === 0) break;
      if (i === 9) {
        for (const pid of alive) {
          log(`Force killing daemon process (PID ${pid})`);
          try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
        }
      }
    }
  } catch (err) {
    // pgrep returns exit 1 when no matches — normal
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      log("[warn] pgrep not found — duplicate detection unavailable");
    }
  }
}

async function acquirePidLock(): Promise<void> {
  await mkdir(dirname(config.paths.pidFile), { recursive: true });

  // Phase 1: Kill any other node process running JuneClaw (catches tmux, old paths, etc.)
  await killDuplicateProcesses();

  // Phase 2: PID file check (catches same-path duplicates)
  try {
    const existing = await readFile(config.paths.pidFile, "utf-8");
    const pid = parseInt(existing.trim(), 10);
    if (!isNaN(pid) && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        console.error(
          `Another daemon instance is already running (PID ${pid}). Exiting.`,
        );
        process.exit(1);
      } catch {
        log(`Removing stale PID file (PID ${pid} not running)`);
      }
    }
  } catch {
    // No PID file — first launch
  }

  await writeFile(config.paths.pidFile, String(process.pid), "utf-8");
}

async function releasePidLock(): Promise<void> {
  try {
    await unlink(config.paths.pidFile);
  } catch {
    // ignore
  }
}

async function saveState(): Promise<void> {
  await mkdir(dirname(config.paths.statePath), { recursive: true, mode: 0o700 });
  await writeFile(
    config.paths.statePath,
    JSON.stringify(state, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
}

function isQuietHour(ch: ChannelConfig): boolean {
  if (Date.now() < quietHoursOverrideUntil) return false;
  const now = new Date();
  const hour = Number(
    now.toLocaleString("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      hour12: false,
    }),
  );
  const { start, end } = ch.quietHours;
  if (start > end) {
    return hour >= start || hour < end;
  }
  return hour >= start && hour < end;
}

/** Handle a quick-lane message: non-blocking, no session, fire-and-forget. */
async function processQuickMessage(
  channel: Channel,
  name: string,
  text: string,
): Promise<void> {
  log(`[quick] responding to: ${text.slice(0, 60)}...`);
  try {
    const response = await quickRespond(text);
    log(`[quick] response: ${response.slice(0, 80)}...`);
    await channel.sendMessage(response);
    await appendDailyLog(name, text, response);
    recordExchange(text, response, "quick");
  } catch (err) {
    logError("[quick] failed", err);
    await channel.sendMessage("처리 중 오류가 발생했습니다.");
  }
}

async function processMessage(
  channel: Channel,
  channelConfig: ChannelConfig,
  text: string,
  taskType: TaskType,
): Promise<void> {
  const phone = channelConfig.phone;
  const name = channelConfig.name;
  await emit("message:received", { from: name });

  if (quietMode.get(phone)) {
    log(`[quiet] skipping message from ${name}`);
    return;
  }

  if (isQuietHour(channelConfig)) {
    log(`[quiet-hours] skipping message from ${name}`);
    return;
  }

  const cmdResult = await handleCommand(text, phone);
  if (cmdResult.handled) {
    if (cmdResult.response) {
      await channel.sendMessage(cmdResult.response);
    }
    return;
  }

  if (text.trim().toLowerCase() === "/quiet") {
    const current = quietMode.get(phone) ?? false;
    quietMode.set(phone, !current);
    await channel.sendMessage(`Quiet mode: ${!current ? "ON" : "OFF"}`);
    return;
  }

  // Quick lane: fire-and-forget, no session needed
  if (taskType === "quick") {
    await processQuickMessage(channel, name, text);
    return;
  }

  const model = getModelForTask(taskType);
  log(`[classify] ${taskType} → ${model}`);

  recordMessage(phone);

  const msgCount = getMessageCount(phone);
  const { messageCountWarning } = config.contextRotation;
  if (msgCount === messageCountWarning) {
    log(`[context] warning: ${msgCount} messages in session for ${phone}`);
  }

  // Check for non-message-count rotation triggers (errors/task failures)
  // before processing — these indicate the session is broken
  const preReason = shouldRotate(phone);
  if (preReason && preReason !== "message_count") {
    log(`[context-rotation] triggered before processing: ${preReason}`);
    await executeRotation(phone, preReason, taskType);
    await emit("rotation:triggered", { reason: preReason });
    await channel.sendMessage(
      `Context rotation triggered (${preReason}). Reprocessing your message in a fresh session.`,
    );
  }

  // Clean up expired sessions for this phone
  const cleaned = await cleanupExpiredSessions(phone);
  if (cleaned.length > 0) {
    log(`[session-pool] expired sessions cleaned: ${cleaned.join(", ")}`);
  }

  // Build system prompt with task-specific strategy injection
  let systemPrompt = await buildSystemPrompt("imessage", name, taskType);
  const recentCtx = getRecentContext();
  const sharedCtx = await getSharedContext();
  if (recentCtx) systemPrompt += "\n\n" + recentCtx;
  if (sharedCtx) systemPrompt += "\n\n" + sharedCtx;

  // Get session for this specific task type
  const sessionId = await getSessionId(phone, taskType);

  try {
    const result = await runClaude({
      prompt: text,
      systemPrompt,
      sessionId,
      model,
      taskType,
    });

    recordSuccess(phone);

    if (result.usage) {
      recordUsage(phone, result.usage);
      log(`[usage] (${taskType}) ${result.usage.totalTokens.toLocaleString()} tokens (${result.usage.usagePercent.toFixed(1)}% of ${result.usage.contextWindow.toLocaleString()}), $${result.usage.costUSD.toFixed(4)}`);
    }

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId, taskType, model);
      state.channels[phone] = {
        sessionId: result.sessionId,
        quiet: quietMode.get(phone) ?? false,
      };
    }

    log(`[response] (${taskType}) ${result.response.slice(0, 80)}...`);
    await channel.sendMessage(result.response);
    await appendDailyLog(name, text, result.response);
    await emit("message:responded", { to: name });

    // Record exchange for cross-session context bridge
    recordExchange(text, result.response, taskType);

    // Update shared context on significant task completions
    if (taskType === "coding" || taskType === "research") {
      const summary = result.response.slice(0, 100).replace(/\n/g, " ");
      await appendSharedContext(`(${taskType}) ${summary}`);
    }

    // Phase 1: Early warning (60%)
    if (shouldWarnContext(phone) && result.usage) {
      log(`[context] warning: ${result.usage.usagePercent.toFixed(1)}% context used`);
      await channel.sendMessage(
        `[Context ${result.usage.usagePercent.toFixed(0)}%] ${taskType} 세션이 곧 리셋됩니다.`,
      );
    }

    // Phase 2: Smart handoff (78%) — Claude writes HANDOFF.md from session context
    if (shouldHandoff(phone) && result.sessionId) {
      const pct = result.usage?.usagePercent.toFixed(0) ?? "?";
      log(`[handoff] context ${pct}% — requesting smart handoff from Claude`);
      await channel.sendMessage(
        `[Context ${pct}%] ${taskType} 세션 핸드오프 준비 중...`,
      );
      try {
        const handoffResult = await writeSmartHandoff(result.sessionId!);
        if (handoffResult.usage) {
          recordUsage(phone, handoffResult.usage);
          log(`[handoff] used ${handoffResult.usage.totalTokens.toLocaleString()} additional tokens`);
        }
        markHandoffDone(phone);
        log("[handoff] HANDOFF.md written by Claude");

        await clearSessionId(phone, taskType);
        await appendSystemLog(
          `Smart handoff completed for ${phone} (${taskType}): context ${pct}%`,
        );
        resetRotationState(phone);
        await emit("rotation:triggered", { reason: "smart_handoff" });
        await channel.sendMessage(
          `${taskType} 세션 핸드오프 완료. 다음 메시지부터 새 세션으로 시작합니다.`,
        );
      } catch (err) {
        logError("[handoff] smart handoff failed, falling back to basic", err);
        markHandoffDone(phone);
        await executeRotation(phone, "token_threshold", taskType);
        await channel.sendMessage(
          `핸드오프 실패 — 기본 핸드오프로 ${taskType} 세션을 리셋합니다.`,
        );
      }
    }

    // Phase 3: Force rotation (90%)
    const postReason = shouldRotate(phone);
    if (postReason) {
      log(`[context-rotation] triggered after processing: ${postReason}`);
      await executeRotation(phone, postReason, taskType);
      await emit("rotation:triggered", { reason: postReason });
      const label = postReason === "token_threshold"
        ? `컨텍스트 ${result.usage?.usagePercent.toFixed(0) ?? "?"}% 도달`
        : `세션 메시지 한도`;
      await channel.sendMessage(
        `Context rotation (${label}). ${taskType} 세션이 리셋됩니다.`,
      );
    }
  } catch (err) {
    recordError(phone);
    await emit("message:error", { error: String(err) }).catch(() => {});
    await logFromError(err, `processMessage from ${name}`).catch(() => {});

    if (
      err instanceof Error &&
      (err.message.includes("context") || err.message.includes("too long"))
    ) {
      recordContextFull(phone);
    }

    throw err;
  }
}

async function runHeartbeat(
  channel: Channel,
  channelConfig: ChannelConfig,
): Promise<void> {
  const phone = channelConfig.phone;
  const name = channelConfig.name;
  const now = new Date();

  log("[heartbeat] running...");

  try {
    // Orphan detection + archive before heartbeat
    const orphanResult = await cleanupStaleAgents();
    if (orphanResult !== "no orphans") {
      log(`[heartbeat] orphan cleanup: ${orphanResult}`);
      await emit("agent:orphan_detected", { result: orphanResult });
    }
    const archiveResult = await archiveCompleted();
    if (archiveResult && !archiveResult.includes("Archived 0")) {
      log(`[heartbeat] ${archiveResult}`);
    }
    const pruned = pruneStaleStates();
    if (pruned > 0) log(`[heartbeat] pruned ${pruned} stale rotation states`);

    const systemPrompt = await buildSystemPrompt("heartbeat", name);
    const sessionId = await getSessionId(phone, "general");

    const prompt = `HEARTBEAT: Check HEARTBEAT.md and follow it. Current time: ${now.toISOString()}. Reply HEARTBEAT_OK if nothing needs attention, otherwise take action.`;

    const result = await runClaude({ prompt, systemPrompt, sessionId, taskType: "general" });

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId, "general");
    }

    state.lastHeartbeatAt = now.toISOString();
    await saveState();

    const response = result.response.trim();
    if (response.includes("HEARTBEAT_OK") || response.includes("NO_REPLY")) {
      log("[heartbeat] OK");
      await emit("heartbeat:ok", { time: now.toISOString() });
    } else {
      log(`[heartbeat] action taken: ${response.slice(0, 100)}`);
      await channel.sendMessage(response);
      await emit("heartbeat:action", { response: response.slice(0, 200) });
    }
  } catch (err) {
    logError("[heartbeat] failed", err);
    await logFromError(err, "heartbeat");
    await emit("heartbeat:failed", { error: String(err) });
  }
}

function initCronScheduler(channel: Channel, channelConfig: ChannelConfig): void {
  log("[cron] initializing scheduler...");

  addJob("heartbeat", config.cron.schedules.heartbeat!, () =>
    runHeartbeat(channel, channelConfig),
  );

  // lessonsLoop removed — now handled by Claude Code remote trigger (daily 00:00 PDT)

  addJob("weeklyCompression", config.cron.schedules.weeklyCompression!, async () => {
    log("[cron] running weekly compression...");
    await emit("cron:started", { job: "weeklyCompression" });
    try {
      await runWeeklyCompression();
      log("[cron] weekly compression completed");
      await emit("cron:completed", { job: "weeklyCompression" });
    } catch (err) {
      logError("[cron] weekly compression failed", err);
      await logFromError(err, "cron:weeklyCompression");
      await emit("cron:failed", { job: "weeklyCompression", error: String(err) });
    }
  });

  addJob("monthlyCompression", config.cron.schedules.monthlyCompression!, async () => {
    log("[cron] running monthly compression...");
    await emit("cron:started", { job: "monthlyCompression" });
    try {
      await runMonthlyCompression();
      log("[cron] monthly compression completed");
      await emit("cron:completed", { job: "monthlyCompression" });
    } catch (err) {
      logError("[cron] monthly compression failed", err);
      await logFromError(err, "cron:monthlyCompression");
      await emit("cron:failed", { job: "monthlyCompression", error: String(err) });
    }
  });

  log("[cron] scheduler initialized");
}

export async function startDaemon(): Promise<void> {
  await acquirePidLock();

  const ch = config.channels.june;
  const channel = createIMessageChannel(ch.phone, ch.chatId);

  await saveState();
  await appendSystemLog(`Daemon started (PID: ${process.pid})`);
  await emit("daemon:startup", { pid: process.pid });

  log(
    `juneclaw daemon started — polling ${ch.name} (${ch.phone}) every ${config.poll.intervalMs}ms`,
  );

  initCronScheduler(channel, ch);

  // Clean stale progress state from previous run
  await clearProgressState();

  // Start external progress monitor (background shell script)
  startProgressMonitor();

  // Notify June that daemon has started
  await channel.sendMessage("JuneClaw restarted").catch((err) => {
    log(`[startup] failed to send restart notification: ${err instanceof Error ? err.message : String(err)}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);
    await emit("daemon:shutdown", { signal });
    stopProgressMonitor();
    stopAllCron();

    // Write handoff for next session
    await writeHandoff({ reason: `daemon shutdown (${signal})` }).catch(() => {});

    // Cascade-kill any sub-agents
    await cascadeKill("juneclaw-main").catch(() => {});

    await releasePidLock();
    await appendSystemLog(`Daemon shutdown (${signal})`);
    await saveState();
    process.exit(0);
  };

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch(() => process.exit(1)); });
  process.on("SIGINT", () => { shutdown("SIGINT").catch(() => process.exit(1)); });

  // Main poll loop
  while (true) {
    // Update liveness timestamp every loop iteration (independent of heartbeat)
    state.lastLoopAt = new Date().toISOString();
    saveState().catch(() => {});

    try {
      const messages = await channel.pollNewMessages();

      for (const msg of messages) {
        if (processedIds.has(msg.id)) continue;
        processedIds.add(msg.id);

        // /btw while processing — queue for follow-up
        if (processing && msg.text.trim().startsWith("/btw ")) {
          const btw = msg.text.trim().slice(5);
          btwQueue.push(btw);
          log(`[btw] queued: ${btw.slice(0, 60)}...`);
          await channel.sendMessage(`메모 접수: ${btw.slice(0, 40)}...`);
          continue;
        }

        log(`[incoming] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

        // User message → override quiet hours for 1 hour
        quietHoursOverrideUntil = Date.now() + 60 * 60 * 1000;

        // Classify the task (Sonnet CLI native, ~1-2s)
        let taskType: TaskType;
        try {
          taskType = await classifyTask(msg.text);
        } catch {
          taskType = "general";
        }

        // Quick lane: process immediately even if heavy work is ongoing
        if (taskType === "quick") {
          processQuickMessage(channel, ch.name, msg.text).catch((err) => {
            logError("[quick] fire-and-forget failed", err);
          });
          continue;
        }

        // Heavy lane: queue if already processing (max 10)
        if (processing) {
          if (pendingMessages.length >= 10) {
            log(`[pending] queue full — dropping: ${msg.text.slice(0, 40)}...`);
            await channel.sendMessage("처리 대기열이 가득 찼습니다. 잠시 후 다시 보내주세요.");
          } else {
            pendingMessages.push({ text: msg.text, taskType });
            log(`[pending] queued (${taskType}): ${msg.text.slice(0, 60)}...`);
          }
          continue;
        }

        try {
          processing = true;
          await writeProgressState(taskType, msg.text, ch.phone);
          await withProcessingLiveness(() => processMessage(channel, ch, msg.text, taskType));
        } catch (err) {
          logError("Failed to process message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        } finally {
          await clearProgressState();
          processing = false;
        }

        // Process /btw queue as follow-up
        if (btwQueue.length > 0) {
          const btws = btwQueue.splice(0);
          const followUp = btws.length === 1
            ? `[작업 중 추가 메시지] ${btws[0]}`
            : `[작업 중 추가 메시지]\n${btws.map((b) => `- ${b}`).join("\n")}`;
          log(`[btw] processing ${btws.length} queued message(s)`);
          try {
            processing = true;
            await writeProgressState("general", followUp, ch.phone);
            await withProcessingLiveness(() => processMessage(channel, ch, followUp, "general"));
          } catch (err) {
            logError("Failed to process /btw follow-up", err);
          } finally {
            await clearProgressState();
            processing = false;
          }
        }
      }

      // Process pending messages (priority: coding > research > general)
      if (pendingMessages.length > 0) {
        pendingMessages.sort((a, b) => {
          const priority: Record<TaskType, number> = { coding: 0, research: 1, general: 2, quick: 3 };
          return priority[a.taskType] - priority[b.taskType];
        });
      }
      while (pendingMessages.length > 0) {
        const pending = pendingMessages.shift()!;
        log(`[pending] processing (${pending.taskType}): ${pending.text.slice(0, 60)}...`);
        try {
          processing = true;
          await writeProgressState(pending.taskType, pending.text, ch.phone);
          await withProcessingLiveness(() => processMessage(channel, ch, pending.text, pending.taskType));
        } catch (err) {
          logError("Failed to process pending message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        } finally {
          await clearProgressState();
          processing = false;
        }
      }
    } catch (err) {
      logError("Poll cycle error", err);
    }

    if (processedIds.size > 10_000) {
      const ids = Array.from(processedIds);
      for (const id of ids.slice(0, ids.length - 1_000)) {
        processedIds.delete(id);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.poll.intervalMs));
  }
}
