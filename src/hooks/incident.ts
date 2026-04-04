import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { config } from "../config.js";

const incidentLog = join(config.workspace, "memory", "incidents.jsonl");
let dirEnsured = false;

export interface Incident {
  timestamp: string;
  severity: "low" | "medium" | "high" | "critical";
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
      symptom: `${context}: ${msg}`,
    });
  } catch {
    // Best-effort logging — never propagate
  }
}
