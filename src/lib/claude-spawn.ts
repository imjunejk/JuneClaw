/**
 * Shared Claude CLI spawn utility for non-interactive --print calls.
 *
 * Used by dream.ts and strategy-tuner.ts to avoid duplicating the
 * spawn + timeout + settled-guard logic.
 */

import { spawn } from "node:child_process";
import { config } from "../config.js";

export interface ClaudeSpawnOptions {
  /** Timeout in milliseconds. Defaults to config.dream.timeoutMs. */
  timeoutMs?: number;
  /** Model override. Defaults to config.dream.model. */
  model?: string;
}

export function spawnClaudePrint(
  prompt: string,
  options: ClaudeSpawnOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const args = [
      "--print",
      "--model", options.model ?? config.dream.model,
      "--permission-mode", config.claude.permissionMode,
    ];

    const child = spawn(config.claude.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = options.timeoutMs ?? config.dream.timeoutMs;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error("TIMEOUT: claude --print call exceeded time limit"));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        // claude CLI prints model/auth errors to stdout, not stderr — include both.
        const detail = (stderr.trim() || stdout.trim() || "(no output)").slice(0, 500);
        reject(new Error(`claude --print exited ${code}: ${detail}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
