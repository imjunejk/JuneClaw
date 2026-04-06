/**
 * Metrics ledger — tracks performance snapshots before/after each dream cycle.
 *
 * Stored as JSONL at ~/.juneclaw/workspace/memory/metrics-ledger.jsonl.
 * Each entry is a MetricsSnapshot taken at dream time for keep/revert decisions.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";
import { loadRecentSignals, type SessionSignal } from "../hooks/signals.js";
import type { FailureCategory } from "../hooks/incident.js";

const ledgerPath = join(config.workspace, "memory", "metrics-ledger.jsonl");

export interface MetricsSnapshot {
  timestamp: string;
  dreamNumber: number;
  period: { from: string; to: string };
  verdict?: "keep" | "revert" | "insufficient_data";
  metrics: SessionMetrics;
}

export interface SessionMetrics {
  successRate: number;
  avgCostPerSession: number;
  avgTokensPerSession: number;
  failureCounts: Partial<Record<FailureCategory, number>>;
  totalSessions: number;
  successCount: number;
  failureCount: number;
}

export async function appendMetrics(snapshot: MetricsSnapshot): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  const line = JSON.stringify(snapshot) + "\n";
  await appendFile(ledgerPath, line, "utf-8");
}

export async function loadRecentMetrics(n: number): Promise<MetricsSnapshot[]> {
  try {
    const raw = await readFile(ledgerPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => JSON.parse(l) as MetricsSnapshot);
  } catch {
    return [];
  }
}

/**
 * Compute metrics from session signals over the last N days.
 */
export function computeMetricsFromSignals(signals: SessionSignal[]): SessionMetrics {
  if (signals.length === 0) {
    return {
      successRate: 0,
      avgCostPerSession: 0,
      avgTokensPerSession: 0,
      failureCounts: {},
      totalSessions: 0,
      successCount: 0,
      failureCount: 0,
    };
  }

  let successCount = 0;
  let failureCount = 0;
  let totalCost = 0;
  let totalTokens = 0;
  const failureCounts: Partial<Record<FailureCategory, number>> = {};

  for (const s of signals) {
    totalCost += s.costUSD;
    totalTokens += s.tokenCount;

    if (s.outcome === "success") {
      successCount++;
    } else {
      failureCount++;
      if (s.category) {
        failureCounts[s.category] = (failureCounts[s.category] ?? 0) + 1;
      }
    }
  }

  const total = signals.length;
  return {
    successRate: total > 0 ? successCount / total : 0,
    avgCostPerSession: total > 0 ? totalCost / total : 0,
    avgTokensPerSession: total > 0 ? totalTokens / total : 0,
    failureCounts,
    totalSessions: total,
    successCount,
    failureCount,
  };
}

/**
 * Compute current metrics from recent daily log signals.
 */
export async function computeCurrentMetrics(days: number): Promise<SessionMetrics> {
  const signals = await loadRecentSignals(days);
  return computeMetricsFromSignals(signals);
}
