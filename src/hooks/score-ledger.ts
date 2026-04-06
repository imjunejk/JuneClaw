/**
 * Score Ledger — persistent TSV log of conversation quality scores.
 *
 * Each scored exchange appends one row to `memory/scores.tsv`.
 * The ledger is the source of truth for the strategy-tuner's
 * hill-climbing keep/discard decisions.
 *
 * Format (tab-separated):
 *   timestamp  taskType  model  score  tokens  costUSD  signals  strategyHash
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

const LEDGER_PATH = join(config.workspace, "memory", "scores.tsv");

const HEADER = "timestamp\ttaskType\tmodel\tscore\ttokens\tcostUSD\tsignals\tstrategyHash\n";

export interface LedgerEntry {
  timestamp: string;
  taskType: string;
  model: string;
  score: number;
  tokens: number;
  costUSD: number;
  signals: string[];
  /** Hash of the strategy files active at the time of the exchange. */
  strategyHash: string;
}

/** Singleton promise prevents concurrent callers from writing duplicate headers. */
let headerPromise: Promise<void> | null = null;

function ensureHeader(): Promise<void> {
  if (!headerPromise) {
    headerPromise = (async () => {
      try {
        const content = await readFile(LEDGER_PATH, "utf-8");
        if (content.startsWith("timestamp\t")) return;
      } catch {
        // File doesn't exist yet
      }
      await mkdir(dirname(LEDGER_PATH), { recursive: true });
      await appendFile(LEDGER_PATH, HEADER, "utf-8");
    })();
  }
  return headerPromise;
}

/** Append a scored exchange to the ledger. */
export async function appendScore(entry: LedgerEntry): Promise<void> {
  await ensureHeader();
  const row = [
    entry.timestamp,
    entry.taskType,
    entry.model,
    entry.score.toFixed(3),
    String(entry.tokens),
    entry.costUSD.toFixed(4),
    entry.signals.join(",") || "none",
    entry.strategyHash,
  ].join("\t") + "\n";
  await appendFile(LEDGER_PATH, row, "utf-8");
}

/** Read the last N entries from the ledger. */
export async function readRecentScores(n: number): Promise<LedgerEntry[]> {
  let content: string;
  try {
    content = await readFile(LEDGER_PATH, "utf-8");
  } catch {
    return [];
  }

  const lines = content.trim().split("\n").slice(1); // skip header
  const recent = lines.slice(-n);

  return recent
    .map((line) => {
      const cols = line.split("\t");
      if (cols.length < 8) return null; // skip malformed rows
      const score = parseFloat(cols[3]!);
      if (isNaN(score)) return null;
      return {
        timestamp: cols[0]!,
        taskType: cols[1]!,
        model: cols[2]!,
        score,
        tokens: parseInt(cols[4]!, 10) || 0,
        costUSD: parseFloat(cols[5]!) || 0,
        signals: cols[6] === "none" ? [] : cols[6]!.split(","),
        strategyHash: cols[7] ?? "",
      };
    })
    .filter((e): e is LedgerEntry => e !== null);
}

/**
 * Compute the average score for a given strategy hash.
 * Returns null if no entries exist for that hash.
 */
export async function averageScoreForStrategy(
  strategyHash: string,
  taskType?: string,
): Promise<{ avg: number; count: number } | null> {
  const entries = await readRecentScores(500);
  const filtered = entries.filter(
    (e) =>
      e.strategyHash === strategyHash &&
      (!taskType || e.taskType === taskType),
  );
  if (filtered.length === 0) return null;

  const sum = filtered.reduce((acc, e) => acc + e.score, 0);
  return { avg: sum / filtered.length, count: filtered.length };
}

