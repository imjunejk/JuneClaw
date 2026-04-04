import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const config = {
  workspace: process.env.CLAWD_WORKSPACE ?? join(home, "openclaw"),
  channels: {
    june: {
      phone: process.env.CLAWD_JUNE_PHONE ?? "+12139992143",
      chatId: 1,
      name: "June",
      quietHours: { start: 23, end: 6 },
    },
  },
  claude: {
    bin: "claude",
    permissionMode: "bypassPermissions" as const,
    allowedTools: [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Agent",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ],
    timeoutMs: 180_000,
    model: process.env.CLAWD_MODEL,
  },
  poll: {
    intervalMs: 2000,
    heartbeatIntervalMs: 10 * 60 * 1000,
  },
  paths: {
    sessions: join(home, ".clawd", "sessions.json"),
    lastSeen: join(home, ".clawd", "last-seen.json"),
    logs: join(home, ".clawd", "logs"),
    statePath: join(home, ".clawd", "state.json"),
    pidFile: join(home, ".clawd", "daemon.pid"),
    watchdogState: join(home, ".clawd", "watchdog-state.txt"),
  },
  subAgents: {
    maxConcurrent: 5,
    maxReviewRounds: 3,
    strategiesPath: join(home, "openclaw", "strategies"),
    toolsPath: join(home, "openclaw", "tools"),
  },
  contextRotation: {
    maxConsecutiveErrors: 10,
    maxTaskFailures: 3,
    messageCountWarning: 35,
    messageCountForceRotate: 40,
  },
  cron: {
    schedules: {
      heartbeat: "*/10 * * * *",
      lessonsLoop: "0 23 * * *",
      weeklyCompression: "0 1 * * 1",
      monthlyCompression: "0 2 1 * *",
    } as Record<string, string>,
  },
};

export type ChannelConfig = (typeof config.channels)[keyof typeof config.channels];
