/**
 * Session outcome signals — structured markers appended to daily logs.
 *
 * These HTML-comment markers are invisible in rendered markdown but
 * machine-readable by the dream system and metrics ledger.
 *
 * Format: <!-- SIGNAL:{"outcome":"success","taskType":"coding",...} -->
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config, type TaskType } from "../config.js";
import type { FailureCategory } from "./incident.js";

export type SessionOutcome = "success" | "failure";

export interface SessionSignal {
  timestamp: string;
  taskType: TaskType;
  outcome: SessionOutcome;
  category?: FailureCategory;
  costUSD: number;
  tokenCount: number;
  durationMs: number;
}

const SIGNAL_PREFIX = "<!-- SIGNAL:";
const SIGNAL_SUFFIX = " -->";

/** Create a fresh regex each call to avoid /g lastIndex state leaks. */
function signalRegex(): RegExp {
  return /<!-- SIGNAL:(\{.*?\}) -->/g;
}

export async function appendSessionSignal(signal: SessionSignal): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]!;
  const dailyPath = join(config.workspace, "memory", "daily", `${dateStr}.md`);
  await mkdir(dirname(dailyPath), { recursive: true });

  const line = `\n${SIGNAL_PREFIX}${JSON.stringify(signal)}${SIGNAL_SUFFIX}\n`;
  await appendFile(dailyPath, line, "utf-8");
}

/**
 * Parse all SIGNAL markers from daily log files for the last N days.
 */
export async function loadRecentSignals(days: number): Promise<SessionSignal[]> {
  const dailyDir = join(config.workspace, "memory", "daily");
  const today = new Date();
  const signals: SessionSignal[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;
    const filePath = join(dailyDir, `${dateStr}.md`);

    try {
      const content = await readFile(filePath, "utf-8");
      const re = signalRegex();
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        try {
          const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
          // Validate required fields to guard against corrupted/stale markers
          if (
            typeof parsed.outcome === "string" &&
            typeof parsed.taskType === "string" &&
            typeof parsed.costUSD === "number" &&
            typeof parsed.tokenCount === "number"
          ) {
            signals.push(parsed as unknown as SessionSignal);
          }
        } catch {
          // Malformed signal line — skip
        }
      }
    } catch {
      // File may not exist for some days
    }
  }

  return signals;
}
