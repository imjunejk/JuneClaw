import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const config = {
  projectDir: process.env.JUNECLAW_PROJECT_DIR ?? join(home, "projects", "juneclaw"),
  workspace: process.env.JUNECLAW_WORKSPACE ?? join(home, "openclaw"),
  channels: {
    june: {
      phone: process.env.JUNECLAW_JUNE_PHONE ?? "+12139992143",
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
    timeoutMs: 600_000,
    model: process.env.JUNECLAW_MODEL,
    modelRouting: {
      defaultModel: process.env.JUNECLAW_DEFAULT_MODEL ?? "claude-sonnet-4-6",
      codingModel: process.env.JUNECLAW_CODING_MODEL ?? "claude-opus-4-6",
    },
  },
  poll: {
    intervalMs: 2000,
    heartbeatIntervalMs: 10 * 60 * 1000,
  },
  progress: {
    firstDelayMs: 15_000,
    intervalMs: 45_000,
  },
  paths: {
    sessions: join(home, ".juneclaw", "sessions.json"),
    lastSeen: join(home, ".juneclaw", "last-seen.json"),
    logs: join(home, ".juneclaw", "logs"),
    statePath: join(home, ".juneclaw", "state.json"),
    pidFile: join(home, ".juneclaw", "daemon.pid"),
    watchdogState: join(home, ".juneclaw", "watchdog-state.txt"),
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
    tokenWarningPercent: 60,
    tokenHandoffPercent: 78,
    tokenForceRotatePercent: 90,
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
