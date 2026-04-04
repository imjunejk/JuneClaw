import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const config = {
  workspace: process.env.CLAWD_WORKSPACE ?? join(home, "openclaw"),
  imessagePhone: process.env.CLAWD_IMESSAGE_PHONE ?? "+12139992143",
  pollIntervalMs: 2_000,
  sessionStorePath: join(home, ".clawd", "sessions.json"),
  lastSeenPath: join(home, ".clawd", "last-seen.json"),
  logDir: join(home, ".clawd", "logs"),
  claudeBin: "claude",
  claudeTimeoutMs: 120_000,
  maxFileChars: 5_000,
};
