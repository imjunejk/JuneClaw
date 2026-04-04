import { writeFile, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config, type ChannelConfig } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId } from "./agent/session.js";
import { buildSystemPrompt } from "./memory/loader.js";
import { appendDailyLog, appendSystemLog } from "./memory/writer.js";
import { broadcast } from "./gateway/broadcast.js";
import { addJob, stopAll as stopAllCron } from "./scheduler/cron.js";
import { runAlgoScript } from "./algo/runner.js";
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

// BUG 1 fix: dedup set + processing lock to prevent duplicate replies
const processedIds = new Set<number>();
let processing = false;

// BUG 3 fix: PID file singleton enforcement
async function acquirePidLock(): Promise<void> {
  await mkdir(dirname(config.paths.pidFile), { recursive: true });

  try {
    const existing = await readFile(config.paths.pidFile, "utf-8");
    const pid = parseInt(existing.trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // check if process exists
        console.error(
          `Another daemon instance is already running (PID ${pid}). Exiting.`,
        );
        process.exit(1);
      } catch {
        // Process doesn't exist — stale PID file, safe to overwrite
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
    // Wraps midnight: e.g. 23–6
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

  // Check quiet mode
  if (quietMode.get(phone)) {
    log(`[quiet] skipping message from ${name}`);
    return;
  }

  // Check quiet hours
  if (isQuietHour(channelConfig)) {
    log(`[quiet-hours] skipping message from ${name}`);
    return;
  }

  // Handle local commands
  const cmdResult = await handleCommand(text, phone);
  if (cmdResult.handled) {
    if (cmdResult.response) {
      await channel.sendMessage(cmdResult.response);
    }
    return;
  }

  // Handle /quiet toggle
  if (text.trim().toLowerCase() === "/quiet") {
    const current = quietMode.get(phone) ?? false;
    quietMode.set(phone, !current);
    await channel.sendMessage(`Quiet mode: ${!current ? "ON" : "OFF"}`);
    return;
  }

  // Build system prompt and run Claude
  const systemPrompt = await buildSystemPrompt("imessage", name);
  const sessionId = await getSessionId(phone);

  const result = await runClaude({
    prompt: text,
    systemPrompt,
    sessionId,
  });

  if (result.sessionId) {
    await setSessionId(phone, result.sessionId);
    state.channels[phone] = {
      sessionId: result.sessionId,
      quiet: quietMode.get(phone) ?? false,
    };
  }

  const response = result.response.trim();

  // Skip empty or suppressed responses
  if (!response || response === "HEARTBEAT_OK" || response === "NO_REPLY") {
    log(`[response] suppressed: ${response || "(empty)"}`);
  } else {
    log(`[response] ${response.slice(0, 80)}...`);
    await channel.sendMessage(response);
  }
  await appendDailyLog(name, text, response);
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
    const systemPrompt = await buildSystemPrompt("heartbeat", name);
    const sessionId = await getSessionId(phone);

    const prompt = `HEARTBEAT: Check HEARTBEAT.md and follow it. Current time: ${now.toISOString()}. Reply HEARTBEAT_OK if nothing needs attention, otherwise take action. Do NOT send any iMessages yourself — just return your text response.`;

    const result = await runClaude({ prompt, systemPrompt, sessionId });

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId);
    }

    state.lastHeartbeatAt = now.toISOString();
    await saveState();

    const response = result.response.trim();
    if (response.includes("HEARTBEAT_OK") || response.includes("NO_REPLY")) {
      log("[heartbeat] OK");
    } else {
      log(`[heartbeat] action taken: ${response.slice(0, 100)}`);
      await channel.sendMessage(response);
    }
  } catch (err) {
    logError("[heartbeat] failed", err);
    await appendSystemLog(`Heartbeat failed: ${err}`);
  }
}

async function runAlgoAndBroadcast(scriptName: string, reportType: string): Promise<void> {
  log(`[algo] running ${scriptName}...`);
  try {
    const result = await runAlgoScript(scriptName);
    if (result.error) {
      logError(`[algo] ${scriptName} failed`, result.error);
      return;
    }
    if (!result.output) {
      log(`[algo] ${scriptName} produced no output`);
      return;
    }
    const sent = await broadcast(reportType, result.output);
    log(`[algo] ${scriptName} → broadcast to ${sent.length}: ${sent.join(", ")}`);
  } catch (err) {
    logError(`[algo] ${scriptName} broadcast failed`, err);
  }
}

function initCronScheduler(channel: Channel, channelConfig: ChannelConfig): void {
  log("[cron] initializing scheduler...");

  // Heartbeat cron (replaces setInterval)
  addJob("heartbeat", config.cron.schedules.heartbeat!, () =>
    runHeartbeat(channel, channelConfig),
  );

  // Algo cron jobs
  const algoJobs: Array<{ name: string; script: string; reportType: string }> = [
    { name: "reporter", script: "reporter", reportType: "unified" },
    { name: "options_monitor", script: "options_monitor", reportType: "options" },
    { name: "stock_scanner", script: "stock_scanner", reportType: "unified" },
    { name: "pump_detector", script: "pump_detector", reportType: "pump" },
  ];

  for (const { name, script, reportType } of algoJobs) {
    const schedule = config.cron.schedules[name];
    if (schedule) {
      addJob(name, schedule, () => runAlgoAndBroadcast(script, reportType));
      log(`[cron] scheduled ${name}: ${schedule}`);
    }
  }

  log("[cron] scheduler initialized");
}

export async function startDaemon(): Promise<void> {
  // BUG 3: Singleton enforcement — refuse to start if another instance is running
  await acquirePidLock();

  const ch = config.channels.june;
  const channel = createIMessageChannel(ch.phone, ch.chatId);

  await saveState();
  await appendSystemLog(`Daemon started (PID: ${process.pid})`);

  log(
    `juneclaw daemon started — polling ${ch.name} (${ch.phone}) every ${config.poll.intervalMs}ms`,
  );

  // Initialize cron scheduler (handles heartbeat + algo jobs)
  initCronScheduler(channel, ch);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down...`);
    stopAllCron();
    await releasePidLock();
    await appendSystemLog(`Daemon shutdown (${signal})`);
    await saveState();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Main poll loop
  while (true) {
    try {
      // Skip poll if already processing a message
      if (!processing) {
        const messages = await channel.pollNewMessages();

        for (const msg of messages) {
          // BUG 1: Skip already-processed message IDs
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

    // Prevent unbounded growth of the dedup set
    if (processedIds.size > 10_000) {
      const ids = Array.from(processedIds);
      for (const id of ids.slice(0, ids.length - 1_000)) {
        processedIds.delete(id);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.poll.intervalMs));
  }
}
