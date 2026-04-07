/**
 * Failure Classifier — automatic clustering of incident patterns.
 *
 * Periodically reads `incidents.jsonl`, groups failures by root cause,
 * and produces actionable rules that feed into the Dream consolidation.
 *
 * Uses infrastructure-level categories distinct from the task-level
 * FailureCategory in incident.ts (which classifies at error-time).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { appendSystemLog } from "../memory/writer.js";

const INCIDENTS_PATH = join(config.workspace, "memory", "incidents.jsonl");
const FAILURE_REPORT_PATH = join(config.workspace, "memory", "lessons", "failure-patterns.md");

/** Infrastructure-level failure categories for incident clustering. */
export type InfraFailureCategory =
  | "timeout"
  | "context"
  | "model"
  | "parse"
  | "spawn"
  | "network"
  | "unknown";

export interface ClassifiedFailure {
  category: InfraFailureCategory;
  symptom: string;
  severity: string;
  timestamp: string;
}

export interface FailureCluster {
  category: InfraFailureCategory;
  count: number;
  recentSymptoms: string[];
  /** Suggested mitigation rule. */
  suggestion: string;
}

// ── Classification rules ────────────────────────────────────────────

const CATEGORY_PATTERNS: { category: InfraFailureCategory; pattern: RegExp }[] = [
  { category: "timeout", pattern: /TIMEOUT|exceeded time limit|timed out/i },
  { category: "context", pattern: /context.*(?:full|exhausted|too long|window)|token.*limit/i },
  { category: "model", pattern: /circuit.?breaker|model.*unavailable|OPEN/i },
  { category: "parse", pattern: /non-JSON|unexpected output|parse|JSON\.parse/i },
  { category: "spawn", pattern: /spawn|ENOENT|command not found|exec/i },
  { category: "network", pattern: /ECONNREFUSED|ENOTFOUND|network|socket|ETIMEDOUT|fetch/i },
];

function classifySymptom(symptom: string): InfraFailureCategory {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(symptom)) return category;
  }
  return "unknown";
}

// ── Suggestion generation ───────────────────────────────────────────

const SUGGESTIONS: Record<InfraFailureCategory, string> = {
  timeout: "Consider reducing prompt complexity or increasing timeoutMs for heavy task types. If frequent, investigate whether tools are causing long execution chains.",
  context: "Context rotation thresholds may need lowering. Check if system prompt size has grown. Consider more aggressive daily log truncation.",
  model: "Model availability issues detected. Ensure fallback model chain is configured. Check if specific task types consistently trigger this.",
  parse: "Claude CLI output parsing failures. May indicate version mismatch or corrupted session. Consider clearing stale sessions on startup.",
  spawn: "Process spawning failures. Check that claude CLI is in PATH and has correct permissions. May indicate resource exhaustion.",
  network: "Network connectivity issues. If persistent, check DNS resolution and proxy settings. Consider adding retry with backoff.",
  unknown: "Unclassified failures. Review recent incidents.jsonl entries for new error patterns to add to the classifier.",
};

// ── Core analysis ───────────────────────────────────────────────────

/**
 * Read and classify all incidents from the last N days.
 */
export async function classifyRecentFailures(days = 7): Promise<ClassifiedFailure[]> {
  let content: string;
  try {
    content = await readFile(INCIDENTS_PATH, "utf-8");
  } catch {
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const lines = content.trim().split("\n").filter(Boolean);
  const classified: ClassifiedFailure[] = [];

  for (const line of lines) {
    try {
      const incident = JSON.parse(line) as {
        timestamp: string;
        severity: string;
        symptom: string;
      };
      if (new Date(incident.timestamp) < cutoff) continue;
      classified.push({
        category: classifySymptom(incident.symptom),
        symptom: incident.symptom,
        severity: incident.severity,
        timestamp: incident.timestamp,
      });
    } catch {
      // Malformed line — skip
    }
  }

  return classified;
}

/**
 * Cluster classified failures by category and generate suggestions.
 */
export function clusterFailures(failures: ClassifiedFailure[]): FailureCluster[] {
  const groups = new Map<InfraFailureCategory, ClassifiedFailure[]>();

  for (const f of failures) {
    const arr = groups.get(f.category) ?? [];
    arr.push(f);
    groups.set(f.category, arr);
  }

  const clusters: FailureCluster[] = [];
  for (const [category, items] of groups) {
    clusters.push({
      category,
      count: items.length,
      recentSymptoms: items
        .slice(-3)
        .map((i) => i.symptom.slice(0, 120)),
      suggestion: SUGGESTIONS[category],
    });
  }

  return clusters.sort((a, b) => b.count - a.count);
}

/**
 * Run the full failure classification pipeline and write a report.
 */
export async function runFailureClassification(): Promise<FailureCluster[]> {
  const failures = await classifyRecentFailures(7);
  if (failures.length === 0) {
    return [];
  }

  const clusters = clusterFailures(failures);

  // Generate markdown report
  const lines: string[] = [
    `# Failure Pattern Report`,
    `_Generated: ${new Date().toISOString()}_`,
    `_Period: last 7 days — ${failures.length} total incidents_`,
    "",
  ];

  for (const cluster of clusters) {
    const pct = ((cluster.count / failures.length) * 100).toFixed(0);
    lines.push(`## ${cluster.category} (${cluster.count}x, ${pct}%)`);
    lines.push("");
    lines.push(`**Suggestion:** ${cluster.suggestion}`);
    lines.push("");
    lines.push("Recent examples:");
    for (const symptom of cluster.recentSymptoms) {
      lines.push(`- ${symptom}`);
    }
    lines.push("");
  }

  await atomicWriteFile(FAILURE_REPORT_PATH, lines.join("\n"));
  await appendSystemLog(
    `[failure-classifier] report generated: ${failures.length} incidents, ${clusters.length} categories`,
  );

  return clusters;
}

/**
 * Check if the incidents file has been updated since the last report.
 */
export async function needsReclassification(): Promise<boolean> {
  try {
    const incidentStat = await stat(INCIDENTS_PATH);
    const reportStat = await stat(FAILURE_REPORT_PATH);
    return incidentStat.mtimeMs > reportStat.mtimeMs;
  } catch {
    try {
      await stat(INCIDENTS_PATH);
      return true; // incidents exist but no report yet
    } catch {
      return false; // no incidents at all
    }
  }
}
