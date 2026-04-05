import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

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

  const entry = `\n## ${formatTime(now)} [${channelName}]\n**${channelName}:** ${userMessage}\n**Youngsu:** ${assistantResponse}\n`;
  await appendFile(dailyPath, entry, "utf-8");
}

export async function appendSystemLog(event: string): Promise<void> {
  const now = new Date();
  const logPath = join(config.workspace, "memory", "system-log.md");

  await mkdir(dirname(logPath), { recursive: true });

  const entry = `\n[${now.toISOString()}] ${event}\n`;
  await appendFile(logPath, entry, "utf-8");
}
