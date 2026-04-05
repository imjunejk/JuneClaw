import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

interface Exchange {
  question: string;
  answer: string;
  taskType: string;
  timestamp: number;
}

/** In-memory recent exchange buffer — shared across all sessions. */
const recentExchanges: Exchange[] = [];

/** Record a Q&A exchange (called after each successful response). */
export function recordExchange(
  question: string,
  answer: string,
  taskType: string,
): void {
  const max = config.contextBridge.maxRecentExchanges;

  // Truncate to keep memory bounded
  const q = question.length > 200 ? question.slice(0, 200) + "..." : question;
  const a = answer.length > 300 ? answer.slice(0, 300) + "..." : answer;

  recentExchanges.push({ question: q, answer: a, taskType, timestamp: Date.now() });
  while (recentExchanges.length > max) {
    recentExchanges.shift();
  }
}

/** Get recent exchanges formatted for system prompt injection. */
export function getRecentContext(): string | null {
  if (recentExchanges.length === 0) return null;

  const lines = recentExchanges.map((ex) => {
    const time = new Date(ex.timestamp).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `[${time}] (${ex.taskType}) Q: ${ex.question}\nA: ${ex.answer}`;
  });

  return `<cross-session-context>\n${lines.join("\n\n")}\n</cross-session-context>`;
}

/** Append a line to the shared context file (persistent cross-session state). */
export async function appendSharedContext(line: string): Promise<void> {
  const path = config.paths.sharedContext;
  await mkdir(dirname(path), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    // no file yet
  }

  const lines = existing.trim().split("\n").filter(Boolean);
  lines.push(`[${new Date().toISOString()}] ${line}`);

  // Keep only the most recent N lines
  const max = config.contextBridge.maxSharedContextLines;
  const trimmed = lines.slice(-max);

  await writeFile(path, trimmed.join("\n") + "\n", "utf-8");
}

/** Read the shared context file for system prompt injection. */
export async function getSharedContext(): Promise<string | null> {
  try {
    const content = await readFile(config.paths.sharedContext, "utf-8");
    if (!content.trim()) return null;
    return `<shared-context>\n${content.trim()}\n</shared-context>`;
  } catch {
    return null;
  }
}

/** Clear the recent exchange buffer (e.g., on full session reset). */
export function clearRecentExchanges(): void {
  recentExchanges.length = 0;
}
