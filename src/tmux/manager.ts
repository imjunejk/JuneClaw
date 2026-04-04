import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SESSION_NAME = "juneclaw";

export async function isRunning(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", SESSION_NAME]);
    return true;
  } catch {
    return false;
  }
}

export async function createSession(): Promise<void> {
  await execFileAsync("tmux", [
    "new-session",
    "-d",
    "-s",
    SESSION_NAME,
    "-n",
    "gateway",
  ]);
}

export async function createWindows(): Promise<void> {
  await execFileAsync("tmux", [
    "new-window",
    "-t",
    `${SESSION_NAME}:1`,
    "-n",
    "logs",
  ]);
  await execFileAsync("tmux", [
    "new-window",
    "-t",
    `${SESSION_NAME}:2`,
    "-n",
    "monitor",
  ]);
}

export async function sendToWindow(
  window: string,
  command: string,
): Promise<void> {
  await execFileAsync("tmux", [
    "send-keys",
    "-t",
    `${SESSION_NAME}:${window}`,
    command,
    "Enter",
  ]);
}

export async function setupFullSession(
  daemonCommand: string,
  logPath: string,
  statePath: string,
): Promise<void> {
  if (await isRunning()) {
    return;
  }

  await createSession();
  await createWindows();

  await sendToWindow("gateway", daemonCommand);
  await sendToWindow("logs", `tail -f ${logPath}`);
  await sendToWindow("monitor", `watch -n5 'cat ${statePath} | jq .'`);

  // Focus gateway window
  await execFileAsync("tmux", [
    "select-window",
    "-t",
    `${SESSION_NAME}:gateway`,
  ]);
}
