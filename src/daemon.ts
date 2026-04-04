import { config } from "./config.js";
import { createIMessageChannel } from "./gateway/imessage.js";
import { buildContext } from "./agent/context.js";
import { runClaude } from "./agent/runner.js";
import { getSessionId, setSessionId } from "./agent/session.js";
import { appendDailyLog } from "./memory/writer.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err: unknown): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${msg}`, err);
}

export async function startDaemon(): Promise<void> {
  const phone = config.imessagePhone;
  const channel = createIMessageChannel(phone);

  log(`clawd daemon started — polling ${phone} every ${config.pollIntervalMs}ms`);

  while (true) {
    try {
      const messages = await channel.pollNewMessages();

      for (const msg of messages) {
        log(`[incoming] ${msg.sender}: ${msg.text.slice(0, 80)}...`);

        try {
          const systemPrompt = await buildContext();
          const sessionId = await getSessionId(phone);

          const result = await runClaude({
            prompt: msg.text,
            systemPrompt,
            sessionId,
          });

          if (result.sessionId) {
            await setSessionId(phone, result.sessionId);
          }

          log(`[response] ${result.response.slice(0, 80)}...`);
          await channel.sendMessage(result.response);
          await appendDailyLog(msg.text, result.response);
        } catch (err) {
          logError("Failed to process message", err);
          await channel.sendMessage("처리 중 오류가 발생했습니다.");
        }
      }
    } catch (err) {
      logError("Poll cycle error", err);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
