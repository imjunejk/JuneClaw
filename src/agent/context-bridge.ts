import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "../config.js";
import { AsyncMutex } from "../lib/async-mutex.js";
import { atomicWriteFile, atomicWriteJson } from "../lib/atomic-file.js";

interface Exchange {
  question: string;
  answer: string;
  taskType: string;
  timestamp: number;
}

/** Path to the persisted recent exchanges file. */
const EXCHANGES_PATH = join(homedir(), ".juneclaw", "recent-exchanges.json");

/** Mutex for recent exchanges disk I/O. */
const exchangesMutex = new AsyncMutex();

/** In-memory recent exchange buffer — shared across all sessions. */
const recentExchanges: Exchange[] = [];

/** Load persisted exchanges from disk (call once at daemon startup). */
export async function loadRecentExchanges(): Promise<void> {
  try {
    const raw = await readFile(EXCHANGES_PATH, "utf-8");
    const parsed: Exchange[] = JSON.parse(raw);
    recentExchanges.length = 0;
    for (const ex of parsed) {
      recentExchanges.push(ex);
    }
  } catch {
    // No file or parse error — start fresh
  }
}

/** Persist current exchanges to disk (best-effort, non-blocking to caller). */
function persistExchanges(): void {
  exchangesMutex
    .run(() => atomicWriteJson(EXCHANGES_PATH, recentExchanges))
    .catch(() => {}); // best-effort — don't let disk errors break message flow
}

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

  // Persist to disk so exchanges survive daemon restarts
  persistExchanges();
}

/** Get recent exchanges formatted for system prompt injection. */
export function getRecentContext(): string | null {
  if (recentExchanges.length === 0) return null;

  const lines = recentExchanges.map((ex) => {
    const time = new Date(ex.timestamp).toLocaleTimeString("en-US", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `[${time}] (${ex.taskType}) Q: ${ex.question}\nA: ${ex.answer}`;
  });

  return `<cross-session-context>\n${lines.join("\n\n")}\n</cross-session-context>`;
}

// Mutex for shared context file — prevents concurrent read-modify-write corruption
const sharedContextMutex = new AsyncMutex();

/** Append a line to the shared context file (persistent cross-session state). */
export async function appendSharedContext(line: string): Promise<void> {
  await sharedContextMutex.run(async () => {
    const path = config.paths.sharedContext;

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

    await atomicWriteFile(path, trimmed.join("\n") + "\n");
  });
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
  persistExchanges();
}
