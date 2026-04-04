import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

async function main(): Promise<void> {
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
