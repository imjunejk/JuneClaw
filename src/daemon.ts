import { writeFile, readFile, readdir, unlink, mkdir, rename } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
import { config, getChannelKey, resolveChannelConfig, type ChannelConfig, type ChannelKey, type TaskType } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId, clearSessionId, cleanupExpiredSessions, getSessionEntries } from "./agent/session.js";
import { classifyTask, getModelForTask } from "./agent/classifier.js";
import { quickRespond } from "./agent/quick-responder.js";
import { recordExchange, getRecentContext, appendSharedContext, getSharedContext, loadRecentExchanges } from "./agent/context-bridge.js";
import { buildSystemPrompt } from "./memory/loader.js";
import { appendDailyLog, appendSystemLog } from "./memory/writer.js";
import { addJob, stopAll as stopAllCron } from "./scheduler/cron.js";
import { cascadeKill, cleanupStaleAgents, cleanupCompletedAgents } from "./agent/subagents.js";
import { writeHandoff, writeSmartHandoff } from "./memory/handoff.js";
import { emit } from "./hooks/events.js";
import { logFromError, inferCategory } from "./hooks/incident.js";
import { appendSessionSignal } from "./hooks/signals.js";
import { recordCost, isOverLimit, isNearLimit, getDailyCost } from "./hooks/cost-monitor.js";
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
import {
  incrementSessionCount,
  loadDreamState,
  saveDreamState,
  evaluatePendingExperiment,
  shouldDream,
  runDream,
} from "./memory/dream.js";
import { scoreExchange, scoreError, type ExchangeMetrics } from "./hooks/quality-scorer.js";
import { appendScore, type LedgerEntry } from "./hooks/score-ledger.js";
import { currentStrategyHash, incrementTunerExchangeCount, flushExchangeCount, runStrategyTuner } from "./memory/strategy-tuner.js";
import { runFailureClassification, needsReclassification } from "./hooks/failure-classifier.js";
import { DurableQueue } from "./lib/durable-queue.js";
import { WorkerPool } from "./lib/worker-pool.js";
import { atomicWriteFile } from "./lib/atomic-file.js";
import { tryAcquireDaemonLock, type DaemonLock } from "./lib/daemon-lock.js";
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
const quietHoursOverrideUntil = new Map<string, number>();
let daemonLock: DaemonLock | null = null;

const processedIds = new Set<number>();
const btwQueue: string[] = [];

// ── Self-improvement: per-phone exchange tracking for quality scoring ──
interface PendingExchange {
  userMessage: string;
  taskType: TaskType;
  model: string;
  tokens: number;
  costUSD: number;
  numTurns: number;
  wasRetry: boolean;
  timedOut: boolean;
  forceRotated: boolean;
  usagePercent: number;
  strategyHash: string;
  timestamp: string;
}

const pendingExchanges = new Map<string, PendingExchange>();
let monitorProcess: ChildProcess | null = null;
let monitorStopped = false;

// ── Durable Queue + Worker Pool ──────────────────────────────
interface QueuedMessage {
  text: string;
  taskType: TaskType;
  phone: string;
  enqueuedAt: number;
}

const messageQueue = new DurableQueue<QueuedMessage>({
  baseDir: join(config.workspace, "queue"),
  maxRetries: 2,
  maxCompleted: 50,
});

// Priority prefix for queue ordering (filenames sort lexicographically)
const taskPriority: Record<TaskType, number> = { coding: 0, research: 1, general: 2, quick: 3 };

// Track which phones have an active heavy worker to prevent session conflicts
const activePhones = new Set<string>();

const workerPool = new WorkerPool({
  maxWorkers: 2,
  onComplete(meta, error) {
    if (error) {
      log(`[pool] worker ${meta.id} failed (${meta.taskType}): ${error.message.slice(0, 80)}`);
    } else {
      log(`[pool] worker ${meta.id} completed (${meta.taskType})`);
    }
  },
});

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
  // Kill orphan child processes from previous daemon instances.
  // Must run BEFORE startProgressMonitor() so we
  // never accidentally kill our own children.

  // Clean up stale Claude session files (zombie prevention)
  try {
    const sessionsDir = join(process.env.HOME ?? "", ".claude", "sessions");
    const files = await readdir(sessionsDir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const pid = parseInt(f.replace(".json", ""), 10);
      if (isNaN(pid)) continue;
      try {
        process.kill(pid, 0); // check if alive — throws ESRCH if dead, EPERM if alive but different user
      } catch (err: unknown) {
        // Only delete if process is truly dead (ESRCH), not just inaccessible (EPERM)
        if ((err as NodeJS.ErrnoException)?.code === "ESRCH") {
          try { await unlink(join(sessionsDir, f)); } catch { /* ok */ }
          log(`[startup] cleaned stale session file: ${f}`);
        }
      }
    }
  } catch { /* sessions dir may not exist */ }

  for (const pattern of [
    "progress-monitor\\.sh",
  ]) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
      const pids = stdout.trim().split("\n").map(Number).filter(Boolean);
      for (const pid of pids) {
        log(`Killing orphan process (PID ${pid}, pattern: ${pattern})`);
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    } catch {
      // No matches — normal
    }
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "dist/index\\.js"]);
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

  // Phase 0: Atomic lock — kernel-level exclusive guard, no race window
  daemonLock = await tryAcquireDaemonLock();
  if (!daemonLock) {
    console.error("Another daemon instance is already running (lock held). Exiting.");
    process.exit(1);
  }

  // Phase 1: Kill any other node process running JuneClaw (catches tmux, old paths, etc.)
  await killDuplicateProcesses();

  // Phase 2: Write PID file (still useful for watchdog scripts and `jc status`)
  await writeFile(config.paths.pidFile, String(process.pid), "utf-8");
}

async function releasePidLock(): Promise<void> {
  if (daemonLock) {
    await daemonLock.release();
    daemonLock = null;
  }
  try {
    await unlink(config.paths.pidFile);
  } catch {
    // ignore
  }
}

async function saveState(): Promise<void> {
  await atomicWriteFile(
    config.paths.statePath,
    JSON.stringify(state, null, 2),
    { mode: 0o600 },
  );
}

function isQuietHour(ch: ChannelConfig): boolean {
  const override = quietHoursOverrideUntil.get(ch.phone) ?? 0;
  if (Date.now() < override) return false;
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

/**
 * Score the previous exchange for a phone (if any) using the new user
 * message as the follow-up signal, then log to the score ledger.
 */
async function scorePreviousExchange(phone: string, followUpMessage: string): Promise<void> {
  const pending = pendingExchanges.get(phone);
  if (!pending) return;
  pendingExchanges.delete(phone);

  try {
    const metrics: ExchangeMetrics = {
      wasRetry: pending.wasRetry,
      timedOut: pending.timedOut,
      forceRotated: pending.forceRotated,
      usagePercent: pending.usagePercent,
      costUSD: pending.costUSD,
      numTurns: pending.numTurns,
    };
    const result = scoreExchange(followUpMessage, metrics);

    const entry: LedgerEntry = {
      timestamp: pending.timestamp,
      taskType: pending.taskType,
      model: pending.model,
      score: result.score,
      tokens: pending.tokens,
      costUSD: pending.costUSD,
      signals: result.signals,
      strategyHash: pending.strategyHash,
    };
    await appendScore(entry);
    incrementTunerExchangeCount();
    await emit("quality:scored", { score: result.score, taskType: pending.taskType });
    log(`[quality] scored ${pending.taskType}: ${result.score.toFixed(2)} [${result.signals.join(",")}]`);
  } catch (err) {
    // Best-effort — never block message processing
    log(`[quality] scoring failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Handle a quick-lane message: non-blocking, no session, fire-and-forget. */
async function processQuickMessage(
  channel: Channel,
  name: string,
  phone: string,
  text: string,
): Promise<void> {
  // Score previous heavy exchange using this quick message as follow-up
  scorePreviousExchange(phone, text).catch((err) => {
    log(`[quality] background scoring failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  log(`[quick] responding to: ${text.slice(0, 60)}...`);
  try {
    const response = await quickRespond(text);
    log(`[quick] response: ${response.slice(0, 80)}...`);
    await channel.sendMessage(response);
    await appendDailyLog(name, text, response);
    recordExchange(text, response, "quick");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError("[quick] failed", err);

    // Quick 실패 시 heavy session으로 에스컬레이션
    if (errMsg.includes("QUICK_TIMEOUT") || errMsg.includes("max turns")) {
      log(`[quick→heavy] escalating to general session: ${text.slice(0, 60)}...`);
      await channel.sendMessage("잠시만요, 더 자세히 확인하고 답할게요.");
      try {
        const channelKey = getChannelKey(phone);
        await processMessage(channel, config.channels[channelKey], text, "general");
      } catch (heavyErr) {
        const heavyErrMsg = heavyErr instanceof Error ? heavyErr.message : String(heavyErr);
        logError("[quick→heavy] escalation also failed", heavyErr);
        await channel.sendMessage(`처리 중 오류: ${heavyErrMsg.slice(0, 200)}`);
      }
    } else {
      await channel.sendMessage(`처리 중 오류: ${errMsg.slice(0, 200)}`);
    }
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

  // Score previous exchange using this new message as the follow-up signal (fire-and-forget)
  scorePreviousExchange(phone, text).catch((err) => {
    log(`[quality] background scoring failed: ${err instanceof Error ? err.message : String(err)}`);
  });

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
    await processQuickMessage(channel, name, phone, text);
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
  const channelKey = getChannelKey(phone);
  let systemPrompt = await buildSystemPrompt(channelKey, name, taskType);
  const recentCtx = getRecentContext();
  const sharedCtx = await getSharedContext();
  if (recentCtx) systemPrompt += "\n\n" + recentCtx;
  if (sharedCtx) systemPrompt += "\n\n" + sharedCtx;

  // Get session for this specific task type
  const sessionId = await getSessionId(phone, taskType);
  const sessionStartMs = Date.now();

  try {
    const result = await runClaude({
      prompt: text,
      systemPrompt,
      sessionId,
      model,
      taskType,
    });

    recordSuccess(phone);

    // Emit success signal for self-improvement metrics
    appendSessionSignal({
      timestamp: new Date().toISOString(),
      taskType,
      outcome: "success",
      costUSD: result.usage?.costUSD ?? 0,
      tokenCount: result.usage?.totalTokens ?? 0,
      durationMs: Date.now() - sessionStartMs,
    }).catch(() => {}); // best-effort

    if (result.usage) {
      recordUsage(phone, result.usage);
      log(`[usage] (${taskType}) ${result.usage.totalTokens.toLocaleString()} tokens (${result.usage.usagePercent.toFixed(1)}% of ${result.usage.contextWindow.toLocaleString()}), $${result.usage.costUSD.toFixed(4)}`);

      // Cost monitor: track daily spend
      recordCost(result.usage.costUSD);
      if (isOverLimit()) {
        const daily = getDailyCost();
        log(`[cost] OVER LIMIT: $${daily.totalUSD.toFixed(2)} today (${daily.callCount} calls)`);
        await channel.sendMessage(
          `[Cost Alert] 오늘 API 비용 $${daily.totalUSD.toFixed(2)} — 일일 한도 초과. 추가 처리를 중단합니다.`,
        );
        return;
      }
      if (isNearLimit()) {
        const daily = getDailyCost();
        log(`[cost] near limit: $${daily.totalUSD.toFixed(2)} today (${daily.callCount} calls)`);
      }
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

    // Store exchange for quality scoring on next user message
    const stratHash = await currentStrategyHash(taskType);
    pendingExchanges.set(phone, {
      userMessage: text,
      taskType,
      model: model ?? config.claude.modelRouting[taskType],
      tokens: result.usage?.totalTokens ?? 0,
      costUSD: result.usage?.costUSD ?? 0,
      numTurns: result.usage?.numTurns ?? 1,
      wasRetry: false,
      timedOut: false,
      forceRotated: false,
      usagePercent: result.usage?.usagePercent ?? 0,
      strategyHash: stratHash,
      timestamp: new Date().toISOString(),
    });

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
        // Do NOT call markHandoffDone here — smart handoff failed, so
        // executeRotation must be allowed to write the basic HANDOFF.md
        // as a fallback. Calling markHandoffDone would make executeRotation
        // skip writeHandoff and leave HANDOFF.md stale.
        await executeRotation(phone, "token_threshold", taskType);
        await channel.sendMessage(
          `핸드오프 실패 — 기본 핸드오프로 ${taskType} 세션을 리셋합니다.`,
        );
      }
    }

    // Phase 3: Force rotation (90%)
    const postReason = shouldRotate(phone);
    if (postReason) {
      // Mark the pending exchange as force-rotated for quality scoring
      const pending = pendingExchanges.get(phone);
      if (pending) pending.forceRotated = true;
      log(`[context-rotation] triggered after processing: ${postReason}`);

      // Attempt smart handoff before forced rotation (only if session alive enough to respond)
      const pct = result.usage?.usagePercent ?? 0;
      const pctStr = pct ? pct.toFixed(0) : "?";
      if (
        result.sessionId
        && postReason === "token_threshold"
        && pct < 95
      ) {
        log(`[handoff] forced rotation at ${pctStr}% — attempting smart handoff first`);
        try {
          const handoffResult = await writeSmartHandoff(result.sessionId);
          if (handoffResult.usage) {
            recordUsage(phone, handoffResult.usage);
          }
          markHandoffDone(phone);
          log("[handoff] smart handoff succeeded during forced rotation");
        } catch (err) {
          logError("[handoff] smart handoff failed during forced rotation, falling back to basic", err);
        }
      }

      // Always go through executeRotation for consistent cleanup
      // (skips writeHandoff internally if smart handoff already succeeded)
      await executeRotation(phone, postReason, taskType);
      await emit("rotation:triggered", { reason: postReason });
      const label = postReason === "token_threshold"
        ? `컨텍스트 ${pctStr}% 도달`
        : `세션 메시지 한도`;
      await channel.sendMessage(
        `Context rotation (${label}). ${taskType} 세션이 리셋됩니다.`,
      );
    }
  } catch (err) {
    recordError(phone);
    await emit("message:error", { error: String(err) }).catch(() => {});
    await logFromError(err, `processMessage from ${name}`).catch(() => {});

    // Emit failure signal for self-improvement metrics
    const errMsg = err instanceof Error ? err.message : String(err);
    appendSessionSignal({
      timestamp: new Date().toISOString(),
      taskType,
      outcome: "failure",
      category: inferCategory(errMsg),
      costUSD: 0,
      tokenCount: 0,
      durationMs: Date.now() - sessionStartMs,
    }).catch(() => {}); // best-effort

    // Score this as a failed exchange for the quality ledger
    try {
      const errScore = scoreError(errMsg);
      const stratHash = await currentStrategyHash(taskType);
      await appendScore({
        timestamp: new Date().toISOString(),
        taskType,
        model: model ?? config.claude.modelRouting[taskType],
        score: errScore.score,
        tokens: 0,
        costUSD: 0,
        signals: errScore.signals,
        strategyHash: stratHash,
      });
      incrementTunerExchangeCount();
    } catch { /* best-effort */ }

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

  // Clean up stale pending exchanges (older than 10 minutes)
  const staleThreshold = Date.now() - 10 * 60_000;
  for (const [pendingPhone, pending] of pendingExchanges) {
    if (new Date(pending.timestamp).getTime() < staleThreshold) {
      pendingExchanges.delete(pendingPhone);
    }
  }

  // Flush in-memory exchange counter to disk
  await flushExchangeCount().catch((err) => {
    log(`[heartbeat] exchange count flush failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  try {
    // Orphan detection + archive before heartbeat
    const orphanResult = await cleanupStaleAgents();
    if (orphanResult !== "no orphans") {
      log(`[heartbeat] orphan cleanup: ${orphanResult}`);
      await emit("agent:orphan_detected", { result: orphanResult });
    }
    // cmd_cleanup prints "Cleaned N entries. M running." — suppress the
    // no-op case (N == 0) so we only log when something actually happened.
    const cleanupResult = await cleanupCompletedAgents();
    if (cleanupResult && !cleanupResult.startsWith("Cleaned 0 ")) {
      log(`[heartbeat] ${cleanupResult}`);
    }
    const pruned = pruneStaleStates();
    if (pruned > 0) log(`[heartbeat] pruned ${pruned} stale rotation states`);

    const systemPrompt = await buildSystemPrompt("june", name);
    const sessionId = await getSessionId(phone, "general");

    const prompt = `HEARTBEAT: Check HEARTBEAT.md and follow it. Current time: ${now.toISOString()}. Reply HEARTBEAT_OK if nothing needs attention, otherwise take action.`;

    const result = await runClaude({ prompt, systemPrompt, sessionId, taskType: "general" });

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId, "general");
    }

    state.lastHeartbeatAt = now.toISOString();
    await saveState();
    // Update lock mtime so watchdog can verify liveness
    await daemonLock?.touch();

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

  // Hill-climbing + autoDream: single dreamState load for both checks
  try {
    const dreamState = await loadDreamState();

    // Evaluate pending experiment independently of dream gate.
    // This ensures evaluations happen even when the daemon has low activity
    // (fewer than 5 sessions / 24h) that wouldn't trigger shouldDream().
    if (dreamState.pendingEvaluation) {
      const evalResult = await evaluatePendingExperiment(dreamState);
      if (evalResult !== null) {
        await saveDreamState(dreamState);
        log(`[dream] hill-climbing evaluation: ${evalResult ? "KEEP" : "REVERT"}`);
      }
    }

    // autoDream: check if memory consolidation should run
    if (shouldDream(dreamState)) {
      log("[dream] trigger conditions met, starting autoDream...");
      await runDream();

      // Run strategy tuner after dream consolidation
      log("[tuner] running strategy tuner after dream...");
      try {
        await runStrategyTuner();
      } catch (tunerErr) {
        logError("[tuner] strategy tuner failed", tunerErr);
      }
    }
  } catch (err) {
    logError("[dream] autoDream/hill-climbing failed", err);
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

  addJob("failureClassification", config.cron.schedules.failureClassification!, async () => {
    log("[cron] running failure classification...");
    await emit("cron:started", { job: "failureClassification" });
    try {
      const needsUpdate = await needsReclassification();
      if (needsUpdate) {
        const clusters = await runFailureClassification();
        log(`[cron] failure classification completed: ${clusters.length} categories`);
        await emit("failures:classified", { categories: clusters.length });
      } else {
        log("[cron] failure classification skipped — no new incidents");
      }
      await emit("cron:completed", { job: "failureClassification" });
    } catch (err) {
      logError("[cron] failure classification failed", err);
      await logFromError(err, "cron:failureClassification");
      await emit("cron:failed", { job: "failureClassification", error: String(err) });
    }
  });

  log("[cron] scheduler initialized");
}

async function ensureWorkspaceDirs(): Promise<void> {
  const ws = config.workspace;
  await mkdir(join(ws, "memory", "daily"), { recursive: true });
  await mkdir(join(ws, "memory", "weekly"), { recursive: true });
  await mkdir(join(ws, "memory", "monthly"), { recursive: true });
  await mkdir(join(ws, "memory", "lessons"), { recursive: true });
  await mkdir(join(ws, "memory", "topics"), { recursive: true });
  await mkdir(join(ws, "strategies"), { recursive: true });
  await mkdir(join(ws, "memory", "strategy-versions"), { recursive: true });
  await mkdir(join(ws, "tools"), { recursive: true });
  await mkdir(join(ws, "skills"), { recursive: true });
}

async function buildStartupReport(): Promise<{ log: string; message: string }> {
  const lines: string[] = ["[startup] === Active Sessions ==="];
  const msgLines: string[] = ["JuneClaw restarted"];

  // 1. Claude CLI sessions from sessions.json (all channels)
  let hasAnySessions = false;
  for (const ch of Object.values(config.channels)) {
    const entries = await getSessionEntries(ch.phone);
    const taskTypes = Object.keys(entries) as TaskType[];
    if (taskTypes.length > 0) {
      hasAnySessions = true;
      msgLines.push("");
      msgLines.push(`세션 (${ch.name}):`);
      for (const tt of taskTypes) {
        const e = entries[tt]!;
        const idle = Math.round((Date.now() - new Date(e.lastActiveAt).getTime()) / 60_000);
        const sid = e.sessionId.slice(0, 8);
        lines.push(`  ${ch.phone}/${tt} — session ${sid}… (model: ${e.model}, ${e.messageCount} msgs, idle ${idle}m)`);
        msgLines.push(`  ${tt}: ${e.model}, ${e.messageCount}건, ${idle}분 전`);
      }
    }
  }
  if (!hasAnySessions) {
    lines.push("  (no active sessions)");
  }

  // 2. Running claude processes (best-effort)
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "claude.*--print"]);
    const myPid = String(process.pid);
    const pids = stdout.trim().split("\n").filter(Boolean).filter(p => p !== myPid);
    if (pids.length > 0) {
      lines.push(`[startup] Running claude processes: ${pids.length} (PIDs: ${pids.join(", ")})`);
    }
  } catch {
    // no matches — normal
  }

  return { log: lines.join("\n"), message: msgLines.join("\n") };
}

export async function startDaemon(): Promise<void> {
  await acquirePidLock();
  await ensureWorkspaceDirs();

  // Restore recent exchanges from disk (survives daemon restart)
  await loadRecentExchanges();

  // Create channels for all configured contacts
  const channelEntries = Object.entries(config.channels).map(([key, ch]) => ({
    key: key as ChannelKey,
    config: ch,
    channel: createIMessageChannel(ch.phone, ch.chatId),
  }));
  const channelByPhone = new Map(channelEntries.map((e) => [e.config.phone, e]));

  // Primary channel (June) — used for heartbeat, cron, startup notifications
  const juneEntry = channelEntries.find((e) => e.key === "june")!;

  // Recover orphaned queue items from previous crash
  const recovered = await messageQueue.recover();
  if (recovered > 0) {
    log(`[queue] recovered ${recovered} orphaned task(s) from previous run`);
  }
  const qStats = await messageQueue.stats();
  if (qStats.pending > 0) {
    log(`[queue] ${qStats.pending} pending task(s) from previous session`);
  }
  if (qStats.dead > 0) {
    log(`[queue] ${qStats.dead} dead-letter task(s)`);
  }

  await saveState();
  await appendSystemLog(`Daemon started (PID: ${process.pid})`);
  await emit("daemon:startup", { pid: process.pid });

  const channelNames = channelEntries.map((e) => `${e.config.name} (${e.config.phone})`).join(", ");
  log(
    `juneclaw daemon started — polling ${channelNames} every ${config.poll.intervalMs}ms`,
  );

  initCronScheduler(juneEntry.channel, juneEntry.config);

  // ─── Hustle Bridge (optional HTTP control) ────────────
  // Exposes daemon control to Hustle UI on localhost:3200.
  // Failures are non-fatal — daemon continues normally.
  import("./bridge/index.js").then((mod) =>
    mod.initBridge({
      sendMessage: async (name, text) => {
        const entry = channelEntries.find(
          (e) => e.config.name === name || e.key === name,
        );
        if (!entry) throw new Error(`Unknown channel: ${name}`);
        await entry.channel.sendMessage(text);
      },
      sendToPhone: async (phone, text) => {
        const { createIMessageChannel } = await import("./gateway/imessage.js");
        const adhoc = createIMessageChannel(phone, 0);
        await adhoc.sendMessage(text);
      },
      enqueueMessage: async (name, text, taskType) => {
        const entry = channelEntries.find(
          (e) => e.config.name === name || e.key === name,
        );
        if (!entry) throw new Error(`Unknown channel: ${name}`);
        const queueId = `bridge-${Date.now()}`;
        const validTypes = ["coding", "research", "general", "quick"] as const;
        const tt = (validTypes as readonly string[]).includes(taskType ?? "") ? (taskType as typeof validTypes[number]) : "general";
        return await messageQueue.enqueue({
          text,
          taskType: tt,
          phone: entry.config.phone,
          enqueuedAt: Date.now(),
        }, queueId);
      },
      getChannels: () => channelEntries.map((e) => ({
        name: e.config.name,
        phone: e.config.phone,
        chatId: e.config.chatId,
        accessLevel: e.config.accessLevel ?? "full",
      })),
    }).then(() => log("[bridge] started on http://127.0.0.1:3200")),
  ).catch((err) => {
    log(`[bridge] failed to start (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });

  // Clean stale progress state from previous run
  await clearProgressState();

  // Start external progress monitor (background shell script)
  startProgressMonitor();

  // Build startup report
  const startupReport = await buildStartupReport();
  log(startupReport.log);

  // Notify June that daemon has started with session summary
  await juneEntry.channel.sendMessage(startupReport.message).catch((err) => {
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

    // Drain worker pool (wait up to 30s for active workers)
    if (workerPool.activeCount > 0) {
      log(`[shutdown] waiting for ${workerPool.activeCount} active worker(s)...`);
      await workerPool.drain(30_000);
    }

    // Move any still-processing queue items back to pending
    const abandoned = await messageQueue.abandonAll();
    if (abandoned > 0) {
      log(`[shutdown] ${abandoned} task(s) returned to queue for next startup`);
    }

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
      // Poll all channels
      for (const entry of channelEntries) {
        const { channel: ch, config: chConfig } = entry;
        const messages = await ch.pollNewMessages();

        for (const msg of messages) {
          if (processedIds.has(msg.id)) continue;
          processedIds.add(msg.id);

          // /btw while workers busy — queue for follow-up (June only)
          if (entry.key === "june" && workerPool.activeCount > 0 && msg.text.trim().startsWith("/btw ")) {
            const btw = msg.text.trim().slice(5);
            btwQueue.push(btw);
            log(`[btw] queued: ${btw.slice(0, 60)}...`);
            await ch.sendMessage(`메모 접수: ${btw.slice(0, 40)}...`);
            continue;
          }

          log(`[incoming] [${chConfig.name}] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

          // User message → override quiet hours for 1 hour (per-channel)
          quietHoursOverrideUntil.set(chConfig.phone, Date.now() + 60 * 60 * 1000);

          // Restricted channels always route to "general"
          let taskType: TaskType;
          if (chConfig.accessLevel === "general") {
            taskType = "general";
          } else {
            try {
              taskType = await classifyTask(msg.text);
            } catch {
              taskType = "general";
            }
          }

          // Quick lane: process immediately even if heavy work is ongoing
          if (taskType === "quick") {
            processQuickMessage(ch, chConfig.name, chConfig.phone, msg.text).catch((err) => {
              logError("[quick] fire-and-forget failed", err);
            });
            continue;
          }

          // Heavy lane: enqueue to durable queue (never drops)
          const priority = taskPriority[taskType] ?? 2;
          const queueId = `${priority}-${msg.id}`;
          const queueResult = await messageQueue.enqueue({
            text: msg.text,
            taskType,
            phone: chConfig.phone,
            enqueuedAt: Date.now(),
          }, queueId);
          const pending = await messageQueue.pendingCount();
          log(`[queue] enqueued ${queueResult} (${taskType}) from ${chConfig.name}, ${pending} pending`);
        }

        // /btw drain: June only
        if (entry.key === "june" && btwQueue.length > 0 && workerPool.hasCapacity() && !activePhones.has(chConfig.phone)) {
          const btws = btwQueue.splice(0);
          const followUp = btws.length === 1
            ? `[작업 중 추가 메시지] ${btws[0]}`
            : `[작업 중 추가 메시지]\n${btws.map((b) => `- ${b}`).join("\n")}`;
          log(`[btw] processing ${btws.length} queued message(s)`);
          activePhones.add(chConfig.phone);
          await workerPool.submit(
            async () => {
              try {
                await writeProgressState("general", followUp, chConfig.phone);
                await withProcessingLiveness(() => processMessage(ch, chConfig, followUp, "general"));
                await incrementSessionCount();
              } catch (err) {
                logError("Failed to process /btw follow-up", err);
              } finally {
                activePhones.delete(chConfig.phone);
                await clearProgressState();
              }
            },
            { taskType: "general", description: "btw follow-up" },
          );
        }
      }

      // ── Worker Pool Drain: claim tasks from queue, submit to pool ──
      while (workerPool.hasCapacity()) {
        const task = await messageQueue.claim();
        if (!task) break;

        const { text, taskType: tt, phone } = task.data;

        // Find the channel entry for this phone
        const entry = channelByPhone.get(phone);
        if (!entry) {
          log(`[pool] unknown phone ${phone}, moving to dead letter`);
          await messageQueue.fail(task.id, `unknown phone: ${phone}`);
          continue;
        }

        // Per-phone serialization: skip if this phone already has an active worker
        if (activePhones.has(phone)) {
          await messageQueue.release(task.id);
          break;
        }

        log(`[pool] dispatching ${task.id} (${tt}) [${entry.config.name}]: ${text.slice(0, 60)}...`);
        activePhones.add(phone);

        await workerPool.submit(
          async () => {
            try {
              await writeProgressState(tt, text, phone);
              await withProcessingLiveness(() => processMessage(entry.channel, entry.config, text, tt));
              await messageQueue.complete(task.id);
              await incrementSessionCount();
            } catch (err) {
              logError(`Failed to process ${task.id}`, err);
              const disposition = await messageQueue.fail(
                task.id,
                err instanceof Error ? err.message : String(err),
              );
              if (disposition === "dead") {
                log(`[queue] ${task.id} moved to dead letter queue after ${task.retryCount + 1} attempts`);
              } else {
                log(`[queue] ${task.id} will retry (attempt ${task.retryCount + 1})`);
              }
              const queueErrMsg = err instanceof Error ? err.message : String(err);
              await entry.channel.sendMessage(`처리 중 오류: ${queueErrMsg.slice(0, 200)}`).catch(() => {});
            } finally {
              activePhones.delete(phone);
              await clearProgressState();
            }
          },
          { taskType: tt, description: text.slice(0, 60) },
        );
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
