import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config, type ChannelConfig } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { handleCommand } from "./gateway/commands.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId } from "./agent/session.js";
import { buildSystemPrompt } from "./memory/loader.js";
import { appendDailyLog, appendSystemLog } from "./memory/writer.js";
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

  log(`[response] ${result.response.slice(0, 80)}...`);
  await channel.sendMessage(result.response);
  await appendDailyLog(name, text, result.response);
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

    const prompt = `HEARTBEAT: Check HEARTBEAT.md and follow it. Current time: ${now.toISOString()}. Reply HEARTBEAT_OK if nothing needs attention, otherwise take action.`;

    const result = await runClaude({ prompt, systemPrompt, sessionId });

    if (result.sessionId) {
      await setSessionId(phone, result.sessionId);
    }

    state.lastHeartbeatAt = now.toISOString();
    await saveState();

    const response = result.response.trim();
    if (response !== "HEARTBEAT_OK") {
      log(`[heartbeat] action taken: ${response.slice(0, 100)}`);
      await channel.sendMessage(response);
    } else {
      log("[heartbeat] OK");
    }
  } catch (err) {
    logError("[heartbeat] failed", err);
    await appendSystemLog(`Heartbeat failed: ${err}`);
  }
}

export async function startDaemon(): Promise<void> {
  const ch = config.channels.june;
  const channel = createIMessageChannel(ch.phone, ch.chatId);

  await saveState();
  await appendSystemLog(`Daemon started (PID: ${process.pid})`);

  log(
    `juneclaw daemon started — polling ${ch.name} (${ch.phone}) every ${config.poll.intervalMs}ms`,
  );

  // Heartbeat interval
  setInterval(() => {
    runHeartbeat(channel, ch).catch((err) =>
      logError("Heartbeat interval error", err),
    );
  }, config.poll.heartbeatIntervalMs);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down...`);
    await appendSystemLog(`Daemon shutdown (${signal})`);
    await saveState();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Main poll loop
  while (true) {
    try {
      const messages = await channel.pollNewMessages();

      for (const msg of messages) {
        log(`[incoming] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

        try {
          await processMessage(channel, ch, msg.text);
        } catch (err) {
          logError("Failed to process message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        }
      }
    } catch (err) {
      logError("Poll cycle error", err);
    }

    await new Promise((resolve) => setTimeout(resolve, config.poll.intervalMs));
  }
}
