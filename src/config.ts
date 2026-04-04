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
  },
  broadcast: {
    recipientsPath: join(home, "openclaw", "market", "recipients.json"),
  },
  algo: {
    basePath: join(home, "gwangsu-algo"),
    python: join(home, "gwangsu-algo", ".venv313", "bin", "python"),
    scripts: {
      reporter: "reporter.py",
      options_monitor: "options_monitor.py",
      stock_scanner: "stock_scanner.py",
      pump_detector: "pump_detector.py",
    } as Record<string, string>,
    timeoutMs: 300_000, // 5 min
  },
  cron: {
    schedules: {
      heartbeat: "*/10 * * * *",           // every 10 min
      reporter: "0 6,12,18,0 * * 1-5",     // 6am, 12pm, 6pm, midnight PT weekdays
      options_monitor: "0 7,10,13,16 * * 1-5", // 7am, 10am, 1pm, 4pm PT weekdays
      stock_scanner: "0 7,16 * * 1-5",     // 7am, 4pm PT weekdays
      pump_detector: "0 8,11,14,17 * * 1-5", // 8am, 11am, 2pm, 5pm PT weekdays
    } as Record<string, string>,
  },
};

export type ChannelConfig = (typeof config.channels)[keyof typeof config.channels];
