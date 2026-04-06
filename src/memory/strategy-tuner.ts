/**
 * Strategy Tuner — hill-climbing auto-improvement of strategy files.
 *
 * Runs as an extension of the Dream cycle. After dream consolidation,
 * the tuner:
 *
 * 1. Reads the score ledger for the last N exchanges per task type.
 * 2. Identifies the lowest-scoring task type as the tuning target.
 * 3. Backs up the current strategy files (versioned snapshot).
 * 4. Asks Claude to produce an improved version based on score trends
 *    and failure signals.
 * 5. Writes the new strategy and records its hash.
 * 6. After enough exchanges accumulate under the new strategy, compares
 *    average scores (keep/discard).
 *
 * Keep/Discard rule (from AutoAgent):
 *   - New avg > old avg          → KEEP
 *   - New avg == old avg + simpler → KEEP
 *   - Otherwise                  → DISCARD (revert to backup)
 */

import { readFile, readdir, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { config, type TaskType } from "../config.js";
import { atomicWriteFile, atomicWriteJson } from "../lib/atomic-file.js";
import { AsyncMutex } from "../lib/async-mutex.js";
import { appendSystemLog } from "./writer.js";
import {
  readRecentScores,
  averageScoreForStrategy,
  type LedgerEntry,
} from "../hooks/score-ledger.js";

// ── State ───────────────────────────────────────────────────────────

export interface TunerState {
  /** Hash of the strategy files *before* the last tuning. */
  previousHash: string | null;
  /** Hash of the strategy files *after* the last tuning (current). */
  currentHash: string | null;
  /** Task type targeted by the last tuning run. */
  targetTaskType: TaskType | null;
  /** ISO timestamp of the last tuning run. */
  lastTunedAt: string | null;
  /** Number of exchanges scored under the current strategy. */
  exchangesSinceLastTune: number;
  /** Total tuning cycles completed. */
  totalTunes: number;
  /** Total reverts (discard). */
  totalReverts: number;
}

const DEFAULT_STATE: TunerState = {
  previousHash: null,
  currentHash: null,
  targetTaskType: null,
  lastTunedAt: null,
  exchangesSinceLastTune: 0,
  totalTunes: 0,
  totalReverts: 0,
};

const TUNER_STATE_PATH = join(
  config.workspace,
  "..",
  "tuner-state.json",
);
const STRATEGY_BACKUP_DIR = join(config.workspace, "memory", "strategy-versions");

/** Minimum exchanges under a new strategy before we evaluate keep/discard. */
const MIN_EVAL_EXCHANGES = 10;

/** Minimum score improvement to keep a new strategy. */
const SCORE_IMPROVEMENT_THRESHOLD = 0.02;

const tunerMutex = new AsyncMutex();

// ── State persistence ───────────────────────────────────────────────

export async function loadTunerState(): Promise<TunerState> {
  try {
    const raw = await readFile(TUNER_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TunerState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveTunerState(state: TunerState): Promise<void> {
  await atomicWriteJson(TUNER_STATE_PATH, state);
}

// ── Strategy hashing ─────���──────────────────────────────────────────

/**
 * Compute a SHA-256 hash of all strategy files for a given task type.
 * This hash is recorded in the score ledger so we can attribute scores
 * to the strategy version that produced them.
 */
export async function hashStrategies(taskType: TaskType): Promise<string> {
  const mapping = config.subAgents.strategyMapping[taskType];
  if (!mapping || mapping.length === 0) return "empty";

  const parts: string[] = [];
  for (const { file } of mapping) {
    const filePath = join(config.subAgents.strategiesPath, file);
    try {
      const content = await readFile(filePath, "utf-8");
      parts.push(content);
    } catch {
      parts.push("");
    }
  }

  return createHash("sha256").update(parts.join("\n---\n")).digest("hex").slice(0, 12);
}

/**
 * Get the current strategy hash for any task type.
 * Convenience wrapper used by the daemon when logging scores.
 */
export async function currentStrategyHash(taskType: TaskType): Promise<string> {
  return hashStrategies(taskType);
}

// ── Backup / restore ────────��───────────────────────────────────────

async function backupStrategies(taskType: TaskType, hash: string): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(STRATEGY_BACKUP_DIR, `${taskType}-${hash}-${ts}`);
  await mkdir(backupDir, { recursive: true });

  const mapping = config.subAgents.strategyMapping[taskType];
  for (const { file } of mapping) {
    const src = join(config.subAgents.strategiesPath, file);
    const dst = join(backupDir, file);
    try {
      await copyFile(src, dst);
    } catch {
      // File may not exist — skip
    }
  }
}

async function restoreStrategies(taskType: TaskType, hash: string): Promise<boolean> {
  // Find the backup directory matching this hash
  let dirs: string[];
  try {
    dirs = await readdir(STRATEGY_BACKUP_DIR);
  } catch {
    return false;
  }

  const prefix = `${taskType}-${hash}-`;
  const match = dirs.filter((d) => d.startsWith(prefix)).sort().pop();
  if (!match) return false;

  const backupDir = join(STRATEGY_BACKUP_DIR, match);
  const mapping = config.subAgents.strategyMapping[taskType];
  for (const { file } of mapping) {
    const src = join(backupDir, file);
    const dst = join(config.subAgents.strategiesPath, file);
    try {
      await copyFile(src, dst);
    } catch {
      // File may not exist in backup — skip
    }
  }
  return true;
}

// ── Claude prompt for strategy improvement ──────────────────────────

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

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      reject(new Error("TIMEOUT: strategy-tuner claude call exceeded time limit"));
    }, config.dream.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`strategy-tuner claude exited ${code}: ${stderr.slice(0, 500)}`));
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

// ── Core tuning logic ────────��──────────────────────────────────────

/**
 * Identify which task type would benefit most from tuning.
 * Returns the task type with the lowest average score (min 5 entries).
 */
async function findTuningTarget(): Promise<{
  taskType: TaskType;
  avgScore: number;
  entries: LedgerEntry[];
} | null> {
  const entries = await readRecentScores(200);
  if (entries.length < 10) return null;

  const taskTypes: TaskType[] = ["coding", "research", "general"];
  let worst: { taskType: TaskType; avgScore: number; entries: LedgerEntry[] } | null = null;

  for (const tt of taskTypes) {
    const ttEntries = entries.filter((e) => e.taskType === tt);
    if (ttEntries.length < 5) continue;

    const avg = ttEntries.reduce((sum, e) => sum + e.score, 0) / ttEntries.length;
    if (!worst || avg < worst.avgScore) {
      worst = { taskType: tt, avgScore: avg, entries: ttEntries };
    }
  }

  return worst;
}

/**
 * Run the strategy tuning cycle. Called from the Dream phase.
 */
export async function runStrategyTuner(): Promise<void> {
  await tunerMutex.run(async () => {
    const state = await loadTunerState();

    // ── Phase A: Evaluate previous tuning (keep/discard) ──────────
    if (
      state.currentHash &&
      state.previousHash &&
      state.targetTaskType &&
      state.exchangesSinceLastTune >= MIN_EVAL_EXCHANGES
    ) {
      const oldStats = await averageScoreForStrategy(state.previousHash, state.targetTaskType);
      const newStats = await averageScoreForStrategy(state.currentHash, state.targetTaskType);

      if (oldStats && newStats) {
        const improved = newStats.avg > oldStats.avg + SCORE_IMPROVEMENT_THRESHOLD;
        const sameScore = Math.abs(newStats.avg - oldStats.avg) <= SCORE_IMPROVEMENT_THRESHOLD;

        if (improved) {
          // KEEP — new strategy is better
          const msg = `[tuner] KEEP strategy for ${state.targetTaskType}: ${oldStats.avg.toFixed(3)} ��� ${newStats.avg.toFixed(3)} (+${(newStats.avg - oldStats.avg).toFixed(3)})`;
          console.log(msg);
          await appendSystemLog(msg);
          state.previousHash = state.currentHash;
        } else if (sameScore) {
          // Same score — keep (simpler check would require token counting, skip for now)
          const msg = `[tuner] KEEP (same score) for ${state.targetTaskType}: ${oldStats.avg.toFixed(3)} ≈ ${newStats.avg.toFixed(3)}`;
          console.log(msg);
          await appendSystemLog(msg);
          state.previousHash = state.currentHash;
        } else {
          // DISCARD — revert to previous strategy
          const msg = `[tuner] DISCARD strategy for ${state.targetTaskType}: ${oldStats.avg.toFixed(3)} → ${newStats.avg.toFixed(3)} (${(newStats.avg - oldStats.avg).toFixed(3)}) — reverting`;
          console.log(msg);
          await appendSystemLog(msg);

          const reverted = await restoreStrategies(state.targetTaskType, state.previousHash);
          if (reverted) {
            state.currentHash = state.previousHash;
            state.totalReverts++;
            await appendSystemLog(`[tuner] reverted ${state.targetTaskType} strategies to ${state.previousHash}`);
          } else {
            await appendSystemLog(`[tuner] WARN: could not find backup for ${state.previousHash}, keeping current`);
          }
        }
      }
    }

    // ── Phase B: Identify next tuning target and improve ──────────
    const target = await findTuningTarget();
    if (!target) {
      // Not enough data yet — skip tuning
      await saveTunerState(state);
      return;
    }

    // Skip if the target already has a high average score
    if (target.avgScore >= 0.75) {
      await saveTunerState(state);
      return;
    }

    const taskType = target.taskType;
    const currentHash = await hashStrategies(taskType);

    // Backup current strategies
    await backupStrategies(taskType, currentHash);

    // Load current strategy files
    const mapping = config.subAgents.strategyMapping[taskType];
    const strategyContents: string[] = [];
    for (const { file, label } of mapping) {
      const filePath = join(config.subAgents.strategiesPath, file);
      try {
        const content = await readFile(filePath, "utf-8");
        strategyContents.push(`### ${label} (${file})\n${content}`);
      } catch {
        strategyContents.push(`### ${label} (${file})\n(file not found)`);
      }
    }

    // Build score summary for the prompt
    const recentScores = target.entries.slice(-30);
    const negativeSignals = new Map<string, number>();
    for (const entry of recentScores) {
      for (const sig of entry.signals) {
        if (sig.startsWith("-")) {
          negativeSignals.set(sig, (negativeSignals.get(sig) ?? 0) + 1);
        }
      }
    }
    const signalSummary = Array.from(negativeSignals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([sig, count]) => `  ${sig}: ${count}x`)
      .join("\n");

    // Ask Claude to improve the strategy
    const prompt = `You are the Strategy Tuner for the JuneClaw AI assistant.

## Task Type: ${taskType}
## Current Average Score: ${target.avgScore.toFixed(3)} / 1.0
## Recent Score Trend (last ${recentScores.length} exchanges):
${recentScores.map((e) => `  ${e.timestamp.slice(5, 16)} score=${e.score.toFixed(2)} signals=[${e.signals.join(",")}]`).join("\n")}

## Top Negative Signals:
${signalSummary || "  (none)"}

## Current Strategy Files:
${strategyContents.join("\n\n")}

## Your Task
Analyze the score patterns and negative signals to identify *general* improvements to the strategy files. Apply the AutoAgent litmus test: "If the worst-scoring exchange disappeared, would this change still improve the agent?"

Rules:
- Focus on root-cause patterns, not individual exchanges
- Keep instructions clear and actionable
- Do NOT add complexity without justification
- If the strategy is already good, make minimal changes
- Preserve the file's structure and section headers

Output the improved strategy file contents in this exact format:
---FILE: filename.md---
(content)
---END---

Output one block per file. Only include files you changed.`;

    try {
      const result = await spawnClaudePrint(prompt);

      if (!result || result.trim().length < 50) {
        console.log("[tuner] Claude returned insufficient content, skipping");
        await appendSystemLog("[tuner] skipped — insufficient content from Claude");
        await saveTunerState(state);
        return;
      }

      // Parse the output and write updated files
      const filePattern = /---FILE:\s*(.+?)---\n([\s\S]*?)---END---/g;
      let match: RegExpExecArray | null;
      let filesUpdated = 0;

      while ((match = filePattern.exec(result)) !== null) {
        const fileName = match[1]!.trim();
        const content = match[2]!.trim();

        // Verify this is a valid strategy file for the target task type
        const isValid = mapping.some((m) => m.file === fileName);
        if (!isValid) {
          console.log(`[tuner] skipping unknown file: ${fileName}`);
          continue;
        }

        const filePath = join(config.subAgents.strategiesPath, fileName);
        await atomicWriteFile(filePath, content + "\n");
        filesUpdated++;
      }

      if (filesUpdated === 0) {
        console.log("[tuner] no valid file updates parsed from Claude output");
        await appendSystemLog("[tuner] skipped — no valid file updates");
        await saveTunerState(state);
        return;
      }

      // Update state
      const newHash = await hashStrategies(taskType);
      state.previousHash = currentHash;
      state.currentHash = newHash;
      state.targetTaskType = taskType;
      state.lastTunedAt = new Date().toISOString();
      state.exchangesSinceLastTune = 0;
      state.totalTunes++;
      await saveTunerState(state);

      const msg = `[tuner] strategy tuning #${state.totalTunes} for ${taskType}: ${filesUpdated} file(s) updated, hash ${currentHash} → ${newHash}`;
      console.log(msg);
      await appendSystemLog(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tuner] failed: ${msg}`);
      await appendSystemLog(`[tuner] failed: ${msg}`);
      // Restore backup on error
      await restoreStrategies(taskType, currentHash);
    }
  });
}

/** Increment the exchange counter (called after each scored exchange). */
export async function incrementTunerExchangeCount(): Promise<void> {
  await tunerMutex.run(async () => {
    const state = await loadTunerState();
    state.exchangesSinceLastTune++;
    await saveTunerState(state);
  });
}
