import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function formatTime(date: Date): string {
  return date.toTimeString().split(" ")[0]!;
}

export async function appendDailyLog(
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

  const entry = `\n### ${formatTime(now)}\n**User:** ${userMessage}\n**Assistant:** ${assistantResponse}\n`;
  await appendFile(dailyPath, entry, "utf-8");
}
