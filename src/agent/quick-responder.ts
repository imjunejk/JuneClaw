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
      // Previously 1 — but Sonnet's extended thinking pass counts as a turn,
      // so a response that required any reasoning step exited with
      // "Reached max turns (1)" (written to stdout, which is why prior error
      // Extended thinking counts as a turn, so 3 was too tight.
      // 5 gives enough headroom for reasoning + response.
      "--max-turns", "5",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    const prompt = `You are Youngsu (영수), a Director-level PM and AI Principal Full Stack Engineer. You work for June (준). Your personality: precise and clear-headed, but relaxed with June. You're bilingual Korean/English — always respond in the same language as the user. Keep answers concise and natural. No emojis unless asked.

## System Context (광수 트레이딩 시스템)
육사 전략 = AgiTQ 60% + SEPA 40%
- AgiTQ: TQQQ 200일선 3구간 (하락→SGOV / 집중투자→TQQQ 2일확인 / 과열→SPY)
- SEPA: TT 8/8 개별주식 + ETF, VCP v2.0, -10% 스탑
- 매매는 portfolio_manager.py가 통합 관리 (유일한 매매 주체)
- 크론 스케줄 (PT):
  월 06:20 리밸런싱 | 06:25 SEPA 스캔+리밋 | 06:35 SEPA 체결확인
  12:50 AgiTQ 준비 | 12:57 AgiTQ 실행(종가 3분전 market) | 13:02 AgiTQ followup(limit)
- Alpaca 라이브 계좌, AGITQ_SYMBOLS: {TQQQ, SGOV, SPY}
- 코드: /Users/jp/gwangsu-algo (GitHub: imjunejk/gwangsu-algo)

Message: ${text}`;
    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores SIGTERM so the next
      // invocation isn't racing a zombie (mirrors runner.ts behavior).
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error("QUICK_TIMEOUT"));
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Include BOTH stdout and stderr in the error — claude CLI sometimes
        // writes error messages to stdout, and empty stderr was masking the
        // actual failure reason in production logs.
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
