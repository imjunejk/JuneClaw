import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config, type ChannelConfig } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId } from "./agent/session.js";
import { buildSystemPrompt } from "./memory/loader.js";
import { appendDailyLog, appendSystemLog } from "./memory/writer.js";
import { addJob, stopAll as stopAllCron } from "./scheduler/cron.js";
import { cascadeKill, cleanupStaleAgents } from "./agent/subagents.js";
import { writeHandoff } from "./memory/handoff.js";
import { emit } from "./hooks/events.js";
import { logFromError } from "./hooks/incident.js";
import {
  recordError,
  recordSuccess,
  recordMessage,
  recordContextFull,
  shouldRotate,
  executeRotation,
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

const processedIds = new Set<number>();
let processing = false;

async function acquirePidLock(): Promise<void> {
  await mkdir(dirname(config.paths.pidFile), { recursive: true });

  try {
    const existing = await readFile(config.paths.pidFile, "utf-8");
    const pid = parseInt(existing.trim(), 10);
    if (!isNaN(pid)) {
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

  try {
    const result = await runClaude({
      prompt: text,
      systemPrompt,
      sessionId,
    });

    recordSuccess(phone);

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

    // Check message-count rotation after processing — message was delivered
    const postReason = shouldRotate(phone);
    if (postReason === "message_count") {
      log(`[context-rotation] triggered after processing: ${postReason}`);
      await executeRotation(phone, postReason);
      await emit("rotation:triggered", { reason: postReason });
      await channel.sendMessage(
        `Context rotation triggered (session message limit). Next message starts a fresh session.`,
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
    // Orphan detection before heartbeat
    const orphanResult = await cleanupStaleAgents();
    if (orphanResult !== "no orphans") {
      log(`[heartbeat] orphan cleanup: ${orphanResult}`);
      await emit("agent:orphan_detected", { result: orphanResult });
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
      if (!processing) {
        const messages = await channel.pollNewMessages();

        for (const msg of messages) {
          if (processedIds.has(msg.id)) continue;
          processedIds.add(msg.id);

          log(`[incoming] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

          try {
            processing = true;
            await processMessage(channel, ch, msg.text);
          } catch (err) {
            logError("Failed to process message", err);
            await channel.sendMessage("처리 중 오류가 발생했습니다.");
          } finally {
            processing = false;
          }
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
