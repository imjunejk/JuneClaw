/**
 * autoDream — memory consolidation during idle time.
 *
 * Like REM sleep: after 24h + 5 sessions since the last dream,
 * the agent reviews recent daily logs and updates master-rules.md
 * with new insights, patterns, and lessons learned.
 *
 * Self-improvement features (inspired by AutoAgent):
 * - Zone-aware editing: only modifies MUTABLE zones in master-rules.md
 * - Hill-climbing gate: measures metrics before/after, reverts if degraded
 * - Failure taxonomy: feeds classified failure signals into analysis
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { atomicWriteJson, atomicWriteFile } from "../lib/atomic-file.js";
import { AsyncMutex } from "../lib/async-mutex.js";
import { appendSystemLog } from "./writer.js";
import { extractMutableZone, replaceMutableZone, hasValidZones } from "./zones.js";
import { loadRecentSignals } from "../hooks/signals.js";
import {
  computeMetricsFromSignals,
  appendMetrics,
  type SessionMetrics,
  type MetricsSnapshot,
} from "./metrics-ledger.js";

export interface DreamState {
  lastDreamAt: string | null;  // ISO timestamp
  sessionsSinceDream: number;
  totalDreams: number;
  /** Hill-climbing: pending evaluation from the most recent dream */
  pendingEvaluation?: {
    dreamNumber: number;
    previousMutableContent: string;
    snapshotBefore: SessionMetrics;
    evaluateAfterDate: string;  // ISO date — evaluate after this date
  };
}

const dreamMutex = new AsyncMutex();

const DEFAULT_STATE: DreamState = {
  lastDreamAt: null,
  sessionsSinceDream: 0,
  totalDreams: 0,
};

export async function loadDreamState(): Promise<DreamState> {
  try {
    const raw = await readFile(config.paths.dreamState, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DreamState>;
    return {
      lastDreamAt: parsed.lastDreamAt ?? null,
      sessionsSinceDream: parsed.sessionsSinceDream ?? 0,
      totalDreams: parsed.totalDreams ?? 0,
      pendingEvaluation: parsed.pendingEvaluation,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveDreamState(state: DreamState): Promise<void> {
  await atomicWriteJson(config.paths.dreamState, state);
}

export async function incrementSessionCount(): Promise<void> {
  await dreamMutex.run(async () => {
    const state = await loadDreamState();
    state.sessionsSinceDream++;
    await saveDreamState(state);
  });
}

export function shouldDream(state: DreamState): boolean {
  if (state.sessionsSinceDream < config.dream.minSessionsSinceLast) return false;

  if (!state.lastDreamAt) return true;

  const elapsed = Date.now() - new Date(state.lastDreamAt).getTime();
  const minMs = config.dream.minHoursSinceLast * 60 * 60 * 1000;
  return elapsed >= minMs;
}

async function loadRecentDailyLogs(days: number): Promise<string> {
  const dailyDir = join(config.workspace, "memory", "daily");
  const today = new Date();
  const logs: string[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;
    const filePath = join(dailyDir, `${dateStr}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      logs.push(`### ${dateStr}\n${content}`);
    } catch {
      // File may not exist for some days
    }
  }

  return logs.length > 0
    ? logs.join("\n\n---\n\n")
    : "(No daily logs found for the last " + days + " days)";
}

async function loadMasterRules(): Promise<string> {
  const rulesPath = join(config.workspace, "memory", "lessons", "master-rules.md");
  try {
    return await readFile(rulesPath, "utf-8");
  } catch {
    return "";
  }
}

function spawnClaudePrint(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--model", config.dream.model,
      "--permission-mode", config.claude.permissionMode,
    ];

    const child = spawn(config.claude.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    child.stdin.write(prompt, "utf-8");
    child.stdin.end();

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error("TIMEOUT: dream claude call exceeded time limit"));
    }, config.dream.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`dream claude exited ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Format session metrics as a human-readable summary for the dream prompt.
 */
function formatMetricsSummary(metrics: SessionMetrics): string {
  const lines = [
    `- Total sessions: ${metrics.totalSessions}`,
    `- Success rate: ${(metrics.successRate * 100).toFixed(1)}% (${metrics.successCount} success, ${metrics.failureCount} failure)`,
    `- Avg cost/session: $${metrics.avgCostPerSession.toFixed(4)}`,
    `- Avg tokens/session: ${Math.round(metrics.avgTokensPerSession).toLocaleString()}`,
  ];

  const cats = Object.entries(metrics.failureCounts);
  if (cats.length > 0) {
    lines.push(`- Failure breakdown: ${cats.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Evaluate the pending hill-climbing experiment from the previous dream.
 * Returns true if the changes were kept, false if reverted.
 */
async function evaluatePendingExperiment(state: DreamState): Promise<boolean | null> {
  const hc = config.dream.hillClimbing;
  if (!hc.enabled || !state.pendingEvaluation) return null;

  const pending = state.pendingEvaluation;
  const now = new Date();
  const evalDate = new Date(pending.evaluateAfterDate);

  // Not yet time to evaluate
  if (now < evalDate) return null;

  // Compute post-dream metrics
  const signals = await loadRecentSignals(hc.evaluationWindowDays);
  const afterMetrics = computeMetricsFromSignals(signals);
  const beforeMetrics = pending.snapshotBefore;

  // Insufficient data — keep changes (can't judge)
  if (afterMetrics.totalSessions < hc.minSessionsForEval) {
    await appendMetrics({
      timestamp: now.toISOString(),
      dreamNumber: pending.dreamNumber,
      period: {
        from: new Date(now.getTime() - hc.evaluationWindowDays * 86400000).toISOString().split("T")[0]!,
        to: now.toISOString().split("T")[0]!,
      },
      verdict: "insufficient_data",
      metrics: afterMetrics,
    });
    await appendSystemLog(
      `autoDream: hill-climbing evaluation #${pending.dreamNumber} — insufficient data (${afterMetrics.totalSessions} sessions < ${hc.minSessionsForEval} minimum), keeping changes`,
    );
    state.pendingEvaluation = undefined;
    return true;
  }

  // Compare metrics
  const successRateDrop = beforeMetrics.successRate - afterMetrics.successRate;
  const costIncrease = beforeMetrics.avgCostPerSession > 0
    ? (afterMetrics.avgCostPerSession - beforeMetrics.avgCostPerSession) / beforeMetrics.avgCostPerSession
    : 0;

  const shouldRevert =
    successRateDrop > hc.successRateRevertThreshold ||
    costIncrease > hc.costIncreaseRevertThreshold;

  if (shouldRevert) {
    // Revert the mutable zone to previous content
    const rulesPath = join(config.workspace, "memory", "lessons", "master-rules.md");
    const currentContent = await loadMasterRules();

    if (hasValidZones(currentContent)) {
      const reverted = replaceMutableZone(currentContent, "dream-insights", pending.previousMutableContent);
      if (reverted) {
        await atomicWriteFile(rulesPath, reverted);
      }
    }

    await appendMetrics({
      timestamp: now.toISOString(),
      dreamNumber: pending.dreamNumber,
      period: {
        from: new Date(now.getTime() - hc.evaluationWindowDays * 86400000).toISOString().split("T")[0]!,
        to: now.toISOString().split("T")[0]!,
      },
      verdict: "revert",
      metrics: afterMetrics,
    });

    const reason = successRateDrop > hc.successRateRevertThreshold
      ? `success rate dropped ${(successRateDrop * 100).toFixed(1)}pp`
      : `cost increased ${(costIncrease * 100).toFixed(1)}%`;

    await appendSystemLog(
      `autoDream: hill-climbing REVERT #${pending.dreamNumber} — ${reason} (before: ${(beforeMetrics.successRate * 100).toFixed(1)}%/$${beforeMetrics.avgCostPerSession.toFixed(4)}, after: ${(afterMetrics.successRate * 100).toFixed(1)}%/$${afterMetrics.avgCostPerSession.toFixed(4)})`,
    );
    console.log(`[dream] hill-climbing REVERT: ${reason}`);

    state.pendingEvaluation = undefined;
    return false;
  }

  // Keep the changes
  await appendMetrics({
    timestamp: now.toISOString(),
    dreamNumber: pending.dreamNumber,
    period: {
      from: new Date(now.getTime() - hc.evaluationWindowDays * 86400000).toISOString().split("T")[0]!,
      to: now.toISOString().split("T")[0]!,
    },
    verdict: "keep",
    metrics: afterMetrics,
  });

  await appendSystemLog(
    `autoDream: hill-climbing KEEP #${pending.dreamNumber} — success ${(afterMetrics.successRate * 100).toFixed(1)}%, cost $${afterMetrics.avgCostPerSession.toFixed(4)}`,
  );
  console.log(`[dream] hill-climbing KEEP: metrics stable or improved`);

  state.pendingEvaluation = undefined;
  return true;
}

export async function runDream(): Promise<void> {
  await dreamMutex.run(async () => {
    const state = await loadDreamState();

    if (!shouldDream(state)) return;

    console.log("[dream] starting autoDream consolidation...");
    await appendSystemLog("autoDream: starting consolidation cycle");

    // ── Hill-climbing: evaluate previous dream's changes ──
    await evaluatePendingExperiment(state);

    // 1. Load recent daily logs (last 3 days)
    const recentLogs = await loadRecentDailyLogs(3);

    // 2. Load current master-rules.md
    const currentRules = await loadMasterRules();

    // 3. Load recent signals for failure analysis
    const recentSignals = await loadRecentSignals(3);
    const currentMetrics = computeMetricsFromSignals(recentSignals);
    const metricsSummary = formatMetricsSummary(currentMetrics);

    // 4. Determine whether to use zone-aware or full-file mode
    const useZones = hasValidZones(currentRules);

    let updatedRules: string;

    if (useZones) {
      // Zone-aware mode: only update the MUTABLE zone
      const currentMutable = extractMutableZone(currentRules, "dream-insights") ?? "";

      const prompt = `You are performing a "dream" memory consolidation cycle for the JuneClaw AI agent (Youngsu).

## Recent Daily Logs (last 3 days)
${recentLogs}

## Performance Metrics (last 3 days)
${metricsSummary}

## Current Fixed Rules (READ-ONLY — do NOT reproduce these)
${currentRules.replace(/<!-- MUTABLE ZONE:[\s\S]*?<!-- END MUTABLE ZONE -->/, "[MUTABLE ZONE REMOVED - you will update this part]")}

## Current Dream Insights (this is what you will update)
${currentMutable || "(empty — first dream cycle)"}

## Your Task
Analyze the recent daily logs and performance metrics for:
- Recurring patterns or habits (good and bad)
- New lessons learned from mistakes or successes
- Failure patterns and their root causes (focus on categories with highest counts)
- Operational insights (what works, what doesn't)

Then produce ONLY the updated Dream Insights section content. Rules:
- DO NOT reproduce the fixed rules — they are read-only context
- Focus on actionable insights that complement (not duplicate) the fixed rules
- Group insights by theme, not by individual incidents
- Remove insights that are no longer relevant
- Keep it concise — aim for quality over quantity
- If a pattern recurs 3+ times, it deserves a rule

Output ONLY the Dream Insights content (no zone markers, no preamble).`;

      const dreamOutput = await spawnClaudePrint(prompt);

      if (!dreamOutput || dreamOutput.trim().length < 20) {
        console.log("[dream] Claude returned insufficient content, skipping update");
        await appendSystemLog("autoDream: skipped — insufficient content from Claude");
        return;
      }

      const replaced = replaceMutableZone(currentRules, "dream-insights", dreamOutput.trim() + "\n");
      if (!replaced) {
        console.log("[dream] failed to replace mutable zone — markers may be corrupted");
        await appendSystemLog("autoDream: ERROR — mutable zone markers not found or corrupted");
        return;
      }

      updatedRules = replaced;
    } else {
      // Legacy mode: full-file update (no zones present)
      const prompt = `You are performing a "dream" memory consolidation cycle for the JuneClaw AI agent (Youngsu).

## Recent Daily Logs (last 3 days)
${recentLogs}

## Performance Metrics (last 3 days)
${metricsSummary}

## Current master-rules.md
${currentRules || "(empty — no rules yet)"}

## Your Task
Analyze the recent daily logs and performance metrics for:
- Recurring patterns or habits (good and bad)
- New lessons learned from mistakes or successes
- Failure patterns and their root causes
- User preferences or corrections that should be remembered
- Operational insights (what works, what doesn't)

Then produce an UPDATED version of master-rules.md that:
- Preserves existing rules that are still relevant
- Adds new insights discovered from the logs
- Modifies rules that need updating based on new evidence
- Removes rules that are no longer applicable or were proven wrong
- Keeps the document concise and actionable

Output ONLY the updated master-rules.md content (no preamble, no explanation).
Start directly with the markdown content.`;

      const dreamOutput = await spawnClaudePrint(prompt);

      if (!dreamOutput || dreamOutput.trim().length < 50) {
        console.log("[dream] Claude returned insufficient content, skipping update");
        await appendSystemLog("autoDream: skipped — insufficient content from Claude");
        return;
      }

      updatedRules = dreamOutput.trim() + "\n";
    }

    // 5. Save pre-dream state for hill-climbing evaluation
    const hc = config.dream.hillClimbing;
    const nextDreamNumber = state.totalDreams + 1;

    if (hc.enabled && useZones) {
      const previousMutable = extractMutableZone(currentRules, "dream-insights") ?? "";
      // Cap stored content at 10KB to keep dream-state.json manageable
      const cappedPrevious = previousMutable.length > 10_000
        ? previousMutable.slice(0, 10_000)
        : previousMutable;

      const evalDate = new Date();
      evalDate.setDate(evalDate.getDate() + hc.evaluationWindowDays);

      state.pendingEvaluation = {
        dreamNumber: nextDreamNumber,
        previousMutableContent: cappedPrevious,
        snapshotBefore: currentMetrics,
        evaluateAfterDate: evalDate.toISOString().split("T")[0]!,
      };
    }

    // 6. Write updated master-rules.md
    const rulesPath = join(config.workspace, "memory", "lessons", "master-rules.md");
    await atomicWriteFile(rulesPath, updatedRules);

    // 7. Log metrics snapshot
    await appendMetrics({
      timestamp: new Date().toISOString(),
      dreamNumber: nextDreamNumber,
      period: {
        from: new Date(Date.now() - 3 * 86400000).toISOString().split("T")[0]!,
        to: new Date().toISOString().split("T")[0]!,
      },
      metrics: currentMetrics,
    });

    // 8. Update dream state
    state.lastDreamAt = new Date().toISOString();
    state.sessionsSinceDream = 0;
    state.totalDreams = nextDreamNumber;
    await saveDreamState(state);

    // 9. Log to system-log.md
    const logMsg = `autoDream: consolidation #${nextDreamNumber} completed — master-rules.md updated (${updatedRules.length} chars, ${useZones ? "zone-aware" : "legacy"} mode, success rate: ${(currentMetrics.successRate * 100).toFixed(1)}%)`;
    console.log(`[dream] ${logMsg}`);
    await appendSystemLog(logMsg);
  });
}
