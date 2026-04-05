import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export type TaskType = "coding" | "research" | "general" | "quick";

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
      coding: process.env.JUNECLAW_CODING_MODEL ?? "claude-opus-4-6",
      research: process.env.JUNECLAW_RESEARCH_MODEL ?? "claude-opus-4-6",
      general: process.env.JUNECLAW_GENERAL_MODEL ?? "claude-sonnet-4-6",
      quick: process.env.JUNECLAW_QUICK_MODEL ?? "claude-sonnet-4-6",
      classifier: process.env.JUNECLAW_CLASSIFIER_MODEL ?? "claude-sonnet-4-6",
    } satisfies Record<TaskType | "classifier", string>,
  },
  poll: {
    intervalMs: 2000,
    heartbeatIntervalMs: 10 * 60 * 1000,
  },
  progress: {
    firstDelayMs: 15_000,
    intervalMs: 45_000,
  },
  sessionPool: {
    idleTimeouts: {
      coding: 10 * 60_000,
      research: 20 * 60_000,
      general: 5 * 60_000,
      quick: 0,
    } satisfies Record<TaskType, number>,
    maxSessionAge: 30 * 60_000,
  },
  paths: {
    sessions: join(home, ".juneclaw", "sessions.json"),
    sharedContext: join(home, ".juneclaw", "shared-context.md"),
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
    /** Strategy files injected per task type. Files not found are silently skipped. */
    strategyMapping: {
      coding: [
        { file: "dev-team-common.md", label: "DEV-TEAM (Common)", maxChars: 5000 },
        { file: "dev-team-youngsik.md", label: "DEV-TEAM (Youngsik — FE)", maxChars: 3000 },
        { file: "dev-team-youngchul.md", label: "DEV-TEAM (Youngchul — BE)", maxChars: 3000 },
      ],
      research: [
        { file: "dev-team-common.md", label: "DEV-TEAM (Common)", maxChars: 5000 },
        { file: "dev-team-kwangsoo.md", label: "DEV-TEAM (Kwangsoo — Strategy)", maxChars: 3000 },
        { file: "dev-team-sangchul.md", label: "DEV-TEAM (Sangchul — Marketing)", maxChars: 3000 },
      ],
      general: [
        { file: "dev-team-youngsu.md", label: "DEV-TEAM (Youngsu — PM)", maxChars: 8000 },
        { file: "dev-team-common.md", label: "DEV-TEAM (Common)", maxChars: 5000 },
        { file: "dev-team-process.md", label: "DEV-TEAM (Process)", maxChars: 5000 },
      ],
      quick: [],
    } satisfies Record<TaskType, { file: string; label: string; maxChars: number }[]>,
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
  contextBridge: {
    maxRecentExchanges: 5,
    maxSharedContextLines: 20,
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
