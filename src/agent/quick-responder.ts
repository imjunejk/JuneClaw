import { spawn } from "node:child_process";
import { config } from "../config.js";
import { readHandoff, SYSTEM_CONTEXT } from "../memory/handoff.js";

/**
 * Quick responder — uses Sonnet CLI with no session for fast, lightweight responses.
 * No tools, no session resume, just a fast answer.
 * Includes system context + HANDOFF.md for continuity after context rotation.
 */
export async function quickRespond(text: string): Promise<string> {
  // Read HANDOFF.md if it exists (context from previous rotated session)
  const handoff = await readHandoff();
  const handoffSection = handoff
    ? `\n## Recent Handoff (이전 세션에서 인계)\n${handoff.slice(0, 2000)}\n`
    : "";

  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, [
      "--print",
      "--output-format", "text",
      "--model", config.claude.modelRouting.quick,
      "--permission-mode", config.claude.permissionMode,
      // Extended thinking counts as a turn, so 3 was too tight.
      // 5 gives enough headroom for reasoning + response.
      "--max-turns", "10",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    const prompt = `You are Youngsu (영수), a Director-level PM and AI Principal Full Stack Engineer. You work for June (준). Your personality: precise and clear-headed, but relaxed with June. You're bilingual Korean/English — always respond in the same language as the user. Keep answers concise and natural. No emojis unless asked.

${SYSTEM_CONTEXT}
${handoffSection}
Message: ${text}`;
    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error("QUICK_TIMEOUT"));
    }, 180_000);  // 3분 (시스템 컨텍스트 + HANDOFF + 추론 여유)

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const errDetail = [
          `code=${code}`,
          stderr.trim() ? `stderr=${stderr.slice(0, 800).trim()}` : null,
          stdout.trim() ? `stdout=${stdout.slice(0, 800).trim()}` : null,
        ].filter(Boolean).join(" | ");
        reject(new Error(`quick-respond failed: ${errDetail || "(no output)"}`));
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
