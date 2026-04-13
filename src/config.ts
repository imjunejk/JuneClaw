import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const workspace = process.env.JUNECLAW_WORKSPACE ?? join(home, ".juneclaw", "workspace");

export type TaskType = "coding" | "research" | "general" | "quick";

export const config = {
  timezone: "America/Los_Angeles",
  projectDir: process.env.JUNECLAW_PROJECT_DIR ?? join(home, "projects", "juneclaw"),
  workspace,
  channels: {
    june: {
      phone: process.env.JUNECLAW_JUNE_PHONE ?? "+12139992143",
      chatId: 1,
      name: "June",
      quietHours: { start: 23, end: 6 },
      accessLevel: "full" as const,
    },
    hamtol: {
      phone: process.env.JUNECLAW_HAMTOL_PHONE ?? "+14156938975",
      chatId: 7,
      name: "햄톨",
      quietHours: { start: 23, end: 6 },
      accessLevel: "general" as const,
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
    /** Tools loaded on-demand when MCP servers are added (not used for built-in tools) */
    deferredTools: [] as string[],
    model: process.env.JUNECLAW_MODEL,
    modelRouting: {
      coding: process.env.JUNECLAW_CODING_MODEL ?? "claude-opus-4-6",
      research: process.env.JUNECLAW_RESEARCH_MODEL ?? "claude-opus-4-6",
      general: process.env.JUNECLAW_GENERAL_MODEL ?? "claude-sonnet-4-6",
      quick: process.env.JUNECLAW_QUICK_MODEL ?? "claude-sonnet-4-6",
      classifier: process.env.JUNECLAW_CLASSIFIER_MODEL ?? "claude-sonnet-4-6",
    } satisfies Record<TaskType | "classifier", string>,
  },
  dream: {
    minHoursSinceLast: 24,
    minSessionsSinceLast: 5,
    model: "claude-sonnet-4-6",
    timeoutMs: 120_000,
    hillClimbing: {
      enabled: true,
      /** Minimum sessions in the measurement window before evaluating */
      minSessionsForEval: 5,
      /** Days to wait after a dream before evaluating its impact */
      evaluationWindowDays: 2,
      /** Revert if success rate drops more than this (0.05 = 5 percentage points) */
      successRateRevertThreshold: 0.05,
      /** Revert if avg cost increases more than this (0.20 = 20%) */
      costIncreaseRevertThreshold: 0.20,
    },
  },
  poll: {
    intervalMs: 2000,
    heartbeatIntervalMs: 10 * 60 * 1000,
  },
  progress: {
    firstDelayMs: 15_000,
    intervalMs: 300_000,
    statePath: join(home, ".juneclaw", "progress-state.json"),
    /** Display names for progress notifications per task type */
    agentNames: {
      coding: "영식+영철",
      research: "광수+상철",
      general: "영수",
      quick: "",
    } satisfies Record<TaskType, string>,
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
    daemonLock: join(home, ".juneclaw", "daemon.lock"),
    watchdogState: join(home, ".juneclaw", "watchdog-state.txt"),
    dreamState: join(home, ".juneclaw", "dream-state.json"),
    tunerState: join(home, ".juneclaw", "tuner-state.json"),
  },
  subAgents: {
    maxConcurrent: 5,
    maxReviewRounds: 3,
    strategiesPath: join(workspace, "strategies"),
    toolsPath: join(workspace, "tools"),
    /** Strategy files injected per task type. Files not found are silently skipped. */
    strategyMapping: {
      coding: [
        { file: "dev-team-common.md", label: "DEV-TEAM (Common)", maxChars: 5000 },
        { file: "dev-team-process.md", label: "DEV-TEAM (Process)", maxChars: 5000 },
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
  costMonitor: {
    dailyLimitUSD: 50,
    warningPercent: 80,
  },
  cron: {
    schedules: {
      heartbeat: "*/10 * * * *",
      weeklyCompression: "0 1 * * 1",
      monthlyCompression: "0 2 1 * *",
      failureClassification: "0 3 * * *", // daily at 3am
    } as Record<string, string>,
  },
  strategyTuner: {
    /** Minimum exchanges under a new strategy before evaluating keep/discard. */
    minEvalExchanges: 10,
    /** Minimum score delta to consider a strategy "improved". */
    scoreImprovementThreshold: 0.02,
    /** Don't tune task types with avg score above this. */
    tuneScoreCeiling: 0.75,
  },
};

export type ChannelConfig = (typeof config.channels)[keyof typeof config.channels];
export type ChannelKey = keyof typeof config.channels;

export function getChannelKey(phone: string): ChannelKey {
  const entry = Object.entries(config.channels).find(([_, ch]) => ch.phone === phone);
  if (!entry) {
    console.warn(`[config] unknown phone ${phone}, falling back to "june"`);
  }
  return (entry?.[0] ?? "june") as ChannelKey;
}
