import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

const incidentLog = join(config.workspace, "memory", "incidents.jsonl");
let dirEnsured = false;

export type FailureCategory =
  | "task_misunderstanding"   // Claude misunderstood the user's intent
  | "tool_underuse"           // Available tool not used when it should have been
  | "incomplete_execution"    // Task started but not finished properly
  | "context_loss"            // Important context dropped during rotation/handoff
  | "cost_waste"              // Excessive tokens/cost for low-value output
  | "infrastructure"          // CLI crash, timeout, circuit breaker trip
  | "uncategorized";

export interface Incident {
  timestamp: string;
  severity: "low" | "medium" | "high" | "critical";
  category?: FailureCategory;
  symptom: string;
  cause?: string;
  recovery?: string;
  prevention?: string;
}

export async function logIncident(incident: Incident): Promise<void> {
  if (!dirEnsured) {
    await mkdir(dirname(incidentLog), { recursive: true });
    dirEnsured = true;
  }
  const line = JSON.stringify(incident) + "\n";
  await appendFile(incidentLog, line, "utf-8");
}

/**
 * Infer a failure category from the error message using keyword heuristics.
 */
export function inferCategory(msg: string): FailureCategory {
  const lower = msg.toLowerCase();
  if (lower.includes("timeout") || lower.includes("exceeded time limit") || lower.includes("sigterm") || lower.includes("circuit")) {
    return "infrastructure";
  }
  if (lower.includes("context") || lower.includes("too long") || lower.includes("rotation")) {
    return "context_loss";
  }
  if (lower.includes("cost") || lower.includes("limit") || lower.includes("budget")) {
    return "cost_waste";
  }
  return "uncategorized";
}

export async function logFromError(
  err: unknown,
  context: string,
  severity: Incident["severity"] = "medium",
): Promise<void> {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    await logIncident({
      timestamp: new Date().toISOString(),
      severity,
      category: inferCategory(msg),
      symptom: `${context}: ${msg}`,
    });
  } catch {
    // Best-effort logging — never propagate
  }
}
