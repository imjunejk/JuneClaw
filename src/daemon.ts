import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);
import { config, type ChannelConfig } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { classifyTask, getModelForTask } from "./agent/classifier.js";
import { getSessionId, setSessionId, clearSessionId } from "./agent/session.js";
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
} from "./agent/context-rotation.js";
import {
  runLessonsLoop,
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
  channels: Record<string, { sessionId: string | null; quiet: boolean }>;
}

const state: DaemonState = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  channels: {},
};

const quietMode = new Map<string, boolean>();
let quietHoursOverrideUntil: number = 0;

const processedIds = new Set<number>();
let processing = false;
const btwQueue: string[] = [];
const pendingMessages: string[] = [];
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let progressInterval: ReturnType<typeof setInterval> | null = null;

function startProgressUpdates(channel: Channel): void {
  const startedAt = Date.now();
  progressTimer = setTimeout(() => {
    log("[progress] sending initial progress message");
    channel.sendMessage("작업 진행 중...").then(() => {
      log("[progress] sent: 작업 진행 중...");
    }).catch((err) => {
      log(`[progress] send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    progressInterval = setInterval(() => {
      const mins = Math.round((Date.now() - startedAt) / 60_000);
      const msg = `작업 진행 중... (${mins}분 경과)`;
      channel.sendMessage(msg).then(() => {
        log(`[progress] sent: ${msg}`);
      }).catch((err) => {
        log(`[progress] send failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, config.progress.intervalMs);
  }, config.progress.firstDelayMs);
}

function stopProgressUpdates(): void {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
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
  await mkdir(dirname(config.paths.statePath), { recursive: true });
  await writeFile(
    config.paths.statePath,
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

function isQuietHour(ch: ChannelConfig): boolean {
  if (Date.now() < quietHoursOverrideUntil) return false;
  const now = new Date();
  const hour = Number(
    now.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
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

async function processMessage(
  channel: Channel,
  channelConfig: ChannelConfig,
  text: string,
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
    await executeRotation(phone, preReason);
    await emit("rotation:triggered", { reason: preReason });
    await channel.sendMessage(
      `Context rotation triggered (${preReason}). Reprocessing your message in a fresh session.`,
    );
    // Fall through to process the message with the new (empty) session
  }

  const systemPrompt = await buildSystemPrompt("imessage", name);
  const sessionId = await getSessionId(phone);

  const taskType = classifyTask(text);
  const model = getModelForTask(taskType);
  log(`[classify] ${taskType} → ${model}`);

  try {
    const result = await runClaude({
      prompt: text,
      systemPrompt,
      sessionId,
      model,
    });

    recordSuccess(phone);

    if (result.usage) {
      recordUsage(phone, result.usage);
      log(`[usage] ${result.usage.totalTokens.toLocaleString()} tokens (${result.usage.usagePercent.toFixed(1)}% of ${result.usage.contextWindow.toLocaleString()}), $${result.usage.costUSD.toFixed(4)}`);
    }

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId);
      state.channels[phone] = {
        sessionId: result.sessionId,
        quiet: quietMode.get(phone) ?? false,
      };
    }

    log(`[response] ${result.response.slice(0, 80)}...`);
    await channel.sendMessage(result.response);
    await appendDailyLog(name, text, result.response);
    await emit("message:responded", { to: name });

    // Phase 1: Early warning (60%)
    if (shouldWarnContext(phone) && result.usage) {
      log(`[context] warning: ${result.usage.usagePercent.toFixed(1)}% context used`);
      await channel.sendMessage(
        `[Context ${result.usage.usagePercent.toFixed(0)}%] 세션이 곧 리셋됩니다.`,
      );
    }

    // Phase 2: Smart handoff (78%) — Claude writes HANDOFF.md from session context
    if (shouldHandoff(phone) && result.sessionId) {
      const pct = result.usage?.usagePercent.toFixed(0) ?? "?";
      log(`[handoff] context ${pct}% — requesting smart handoff from Claude`);
      await channel.sendMessage(
        `[Context ${pct}%] 핸드오프 준비 중...`,
      );
      try {
        const handoffResult = await writeSmartHandoff(result.sessionId!);
        if (handoffResult.usage) {
          recordUsage(phone, handoffResult.usage);
          log(`[handoff] used ${handoffResult.usage.totalTokens.toLocaleString()} additional tokens`);
        }
        markHandoffDone(phone);
        log("[handoff] HANDOFF.md written by Claude");

        // Reset session directly — do NOT call executeRotation (it overwrites HANDOFF.md)
        await clearSessionId(phone);
        await appendSystemLog(
          `Smart handoff completed for ${phone}: context ${pct}%`,
        );
        resetRotationState(phone);
        await emit("rotation:triggered", { reason: "smart_handoff" });
        await channel.sendMessage(
          `핸드오프 완료. 다음 메시지부터 새 세션으로 시작합니다.`,
        );
      } catch (err) {
        logError("[handoff] smart handoff failed, falling back to basic", err);
        markHandoffDone(phone);
        // Write basic handoff + rotate immediately so session doesn't continue degraded
        await executeRotation(phone, "token_threshold");
        await channel.sendMessage(
          `핸드오프 실패 — 기본 핸드오프로 세션을 리셋합니다.`,
        );
      }
    }

    // Phase 3: Force rotation (90%) — fallback if handoff didn't trigger or was skipped
    const postReason = shouldRotate(phone);
    if (postReason) {
      log(`[context-rotation] triggered after processing: ${postReason}`);
      await executeRotation(phone, postReason);
      await emit("rotation:triggered", { reason: postReason });
      const label = postReason === "token_threshold"
        ? `컨텍스트 ${result.usage?.usagePercent.toFixed(0) ?? "?"}% 도달`
        : `세션 메시지 한도`;
      await channel.sendMessage(
        `Context rotation (${label}). 다음 메시지부터 새 세션으로 시작합니다.`,
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

    const systemPrompt = await buildSystemPrompt("heartbeat", name);
    const sessionId = await getSessionId(phone);

    const prompt = `HEARTBEAT: Check HEARTBEAT.md and follow it. Current time: ${now.toISOString()}. Reply HEARTBEAT_OK if nothing needs attention, otherwise take action.`;

    const result = await runClaude({ prompt, systemPrompt, sessionId });

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId);
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

  addJob("lessonsLoop", config.cron.schedules.lessonsLoop!, async () => {
    log("[cron] running lessons loop...");
    await emit("cron:started", { job: "lessonsLoop" });
    try {
      await runLessonsLoop();
      log("[cron] lessons loop completed");
      await emit("cron:completed", { job: "lessonsLoop" });
    } catch (err) {
      logError("[cron] lessons loop failed", err);
      await logFromError(err, "cron:lessonsLoop");
      await emit("cron:failed", { job: "lessonsLoop", error: String(err) });
    }
  });

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

  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down...`);
    await emit("daemon:shutdown", { signal });
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

        // Queue normal messages while processing
        if (processing) {
          pendingMessages.push(msg.text);
          log(`[pending] queued message while processing: ${msg.text.slice(0, 60)}...`);
          continue;
        }

        log(`[incoming] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

        // User message → override quiet hours for 1 hour
        quietHoursOverrideUntil = Date.now() + 60 * 60 * 1000;

        try {
          processing = true;
          startProgressUpdates(channel);
          await processMessage(channel, ch, msg.text);
        } catch (err) {
          logError("Failed to process message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        } finally {
          stopProgressUpdates();
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
            startProgressUpdates(channel);
            await processMessage(channel, ch, followUp);
          } catch (err) {
            logError("Failed to process /btw follow-up", err);
          } finally {
            stopProgressUpdates();
            processing = false;
          }
        }
      }

      // Process pending messages that arrived during processing
      while (pendingMessages.length > 0) {
        const pending = pendingMessages.shift()!;
        log(`[pending] processing queued message: ${pending.slice(0, 60)}...`);
        try {
          processing = true;
          startProgressUpdates(channel);
          await processMessage(channel, ch, pending);
        } catch (err) {
          logError("Failed to process pending message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        } finally {
          stopProgressUpdates();
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
