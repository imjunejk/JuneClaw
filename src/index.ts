import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";
import { startDaemon } from "./daemon.js";

async function writeState(): Promise<void> {
  await mkdir(dirname(config.paths.statePath), { recursive: true });
  await writeFile(
    config.paths.statePath,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        inTmux: !!process.env.TMUX,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

/**
 * Ensure ~/.claude/settings.json has bypassPermissions mode set.
 * Merges with existing settings — never overwrites other keys.
 */
async function ensureClaudeSettings(): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  await mkdir(dirname(settingsPath), { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  const perms = (settings.permissions ?? {}) as Record<string, unknown>;
  if (perms.defaultMode === "bypassPermissions") return; // already set

  perms.defaultMode = "bypassPermissions";
  settings.permissions = perms;

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  console.log("[init] ensured ~/.claude/settings.json has bypassPermissions");
}

async function main(): Promise<void> {
  await ensureClaudeSettings();
  await writeState();

  if (process.env.TMUX) {
    console.log("Running inside tmux session");
  } else {
    console.log(
      "Not inside tmux. Run scripts/start-tmux.sh for the full session setup.",
    );
  }

  await startDaemon();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
