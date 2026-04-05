import { spawn } from "node:child_process";
import { config } from "../config.js";

/**
 * Quick responder — uses Sonnet CLI with no session for fast, lightweight responses.
 * No tools, no session resume, just a fast answer.
 */
export async function quickRespond(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, [
      "--print",
      "--output-format", "text",
      "--model", config.claude.modelRouting.quick,
      "--permission-mode", config.claude.permissionMode,
      "--max-turns", "1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    const prompt = `You are Youngsu (영수), a Director-level PM and AI Principal Full Stack Engineer. You work for June (준). Your personality: precise and clear-headed, but relaxed with June. You're bilingual Korean/English — always respond in the same language as the user. Keep answers concise and natural. No emojis unless asked.\n\nMessage: ${text}`;
    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("QUICK_TIMEOUT"));
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`quick-respond exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
