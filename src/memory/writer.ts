import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

// Per-entry truncation caps for the daily log (H2 Phase 2).
//
// Previously `appendDailyLog` stored the full user message and full
// assistant response on every exchange. A typical coding response is
// 5-10 KB of markdown + code; over a day of heavy use this grew the
// daily file to ~56 KB, which the loader then clipped to 8 KB anyway
// (losing the most recent exchanges, which are the most relevant).
//
// The daily log is supposed to be a *journal*, not a transcript —
// full conversation state is already captured in Claude session
// history. Truncation keeps the journal bounded and useful as context.
const USER_MSG_MAX_CHARS = 300;
const ASSISTANT_MSG_MAX_CHARS = 600;

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Truncate a message to roughly maxChars code points, appending a
 * `…(+N more)` indicator if anything was cut. Collapses whitespace first
 * so multi-line messages don't stretch the journal vertically.
 *
 * Note: uses code-point splitting (via `[...str]`) rather than `slice()`
 * so an emoji or other supplementary-plane character never gets cut in
 * the middle of its surrogate pair.
 */
function truncateForJournal(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const codePoints = [...collapsed];
  if (codePoints.length <= maxChars) return collapsed;
  const kept = codePoints.slice(0, maxChars).join("");
  const extra = codePoints.length - maxChars;
  return `${kept}…(+${extra} more)`;
}

export async function appendDailyLog(
  channelName: string,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const now = new Date();
  const dailyPath = join(
    config.workspace,
    "memory",
    "daily",
    `${formatDate(now)}.md`,
  );

  await mkdir(dirname(dailyPath), { recursive: true });

  const userSummary = truncateForJournal(userMessage, USER_MSG_MAX_CHARS);
  const assistantSummary = truncateForJournal(assistantResponse, ASSISTANT_MSG_MAX_CHARS);
  const entry = `\n## ${formatTime(now)} [${channelName}]\n**${channelName}:** ${userSummary}\n**Youngsu:** ${assistantSummary}\n`;
  await appendFile(dailyPath, entry, "utf-8");
}

export async function appendSystemLog(event: string): Promise<void> {
  const now = new Date();
  const logPath = join(config.workspace, "memory", "system-log.md");

  await mkdir(dirname(logPath), { recursive: true });

  const entry = `\n[${now.toISOString()}] ${event}\n`;
  await appendFile(logPath, entry, "utf-8");
}
