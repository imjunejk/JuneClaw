/**
 * autoDream — memory consolidation during idle time.
 *
 * Like REM sleep: after 24h + 5 sessions since the last dream,
 * the agent reviews recent daily logs and updates master-rules.md
 * with new insights, patterns, and lessons learned.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { atomicWriteJson, atomicWriteFile } from "../lib/atomic-file.js";
import { AsyncMutex } from "../lib/async-mutex.js";
import { appendSystemLog } from "./writer.js";

export interface DreamState {
  lastDreamAt: string | null;  // ISO timestamp
  sessionsSinceDream: number;
  totalDreams: number;
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

export async function runDream(): Promise<void> {
  await dreamMutex.run(async () => {
    const state = await loadDreamState();

    if (!shouldDream(state)) return;

    console.log("[dream] starting autoDream consolidation...");
    await appendSystemLog("autoDream: starting consolidation cycle");

    // 1. Load recent daily logs (last 3 days)
    const recentLogs = await loadRecentDailyLogs(3);

    // 2. Load current master-rules.md
    const currentRules = await loadMasterRules();

    // 3. Call Claude to analyze and produce updated rules
    const prompt = `You are performing a "dream" memory consolidation cycle for the JuneClaw AI agent (Youngsu).

## Recent Daily Logs (last 3 days)
${recentLogs}

## Current master-rules.md
${currentRules || "(empty — no rules yet)"}

## Your Task
Analyze the recent daily logs for:
- Recurring patterns or habits (good and bad)
- New lessons learned from mistakes or successes
- Important decisions and their outcomes
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

    const updatedRules = await spawnClaudePrint(prompt);

    if (!updatedRules || updatedRules.trim().length < 50) {
      console.log("[dream] Claude returned insufficient content, skipping update");
      await appendSystemLog("autoDream: skipped — insufficient content from Claude");
      return;
    }

    // 4. Write updated master-rules.md
    const rulesPath = join(config.workspace, "memory", "lessons", "master-rules.md");
    await atomicWriteFile(rulesPath, updatedRules.trim() + "\n");

    // 5. Update dream state
    state.lastDreamAt = new Date().toISOString();
    state.sessionsSinceDream = 0;
    state.totalDreams++;
    await saveDreamState(state);

    // 6. Log to system-log.md
    const logMsg = `autoDream: consolidation #${state.totalDreams} completed — master-rules.md updated (${updatedRules.trim().length} chars)`;
    console.log(`[dream] ${logMsg}`);
    await appendSystemLog(logMsg);
  });
}
