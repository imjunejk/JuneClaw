import { spawn } from "node:child_process";
import { config, type TaskType } from "../config.js";

const VALID_TYPES: TaskType[] = ["coding", "research", "general", "quick"];

const CLASSIFIER_PROMPT = `Classify this message into exactly one category. Reply with ONLY the category name, nothing else.
- coding: code writing, debugging, PR, deployment, build, git, refactor, test writing, error fixing
- research: web search needed, market analysis, competitor research, data gathering, deep investigation
- quick: simple factual question, status check, greeting, acknowledgment, yes/no, time/weather
- general: everything else (planning, discussion, strategy, file management, conversation)
Category:`;

/** Force-override map for slash commands. */
const COMMAND_OVERRIDES: Record<string, TaskType> = {
  "/code": "coding",
  "/fix": "coding",
  "/implement": "coding",
  "/refactor": "coding",
  "/debug": "coding",
  "/build": "coding",
  "/deploy": "coding",
  "/pr": "coding",
  "/commit": "coding",
  "/merge": "coding",
  "/review": "coding",
  "/research": "research",
  "/search": "research",
};

function spawnClassifier(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, [
      "--print",
      "--output-format", "text",
      "--model", config.claude.modelRouting.classifier,
      "--max-turns", "1",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    child.stdin.write(`${CLASSIFIER_PROMPT}\nMessage: ${text.slice(0, 500)}`, "utf-8");
    child.stdin.end();

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CLASSIFIER_TIMEOUT"));
    }, 15_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`classifier exited ${code}`));
      } else {
        resolve(stdout.trim().toLowerCase());
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseTaskType(raw: string): TaskType {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (VALID_TYPES.includes(cleaned as TaskType)) return cleaned as TaskType;
  return "general";
}

let forceNextType: TaskType | null = null;

/** Override the next classification result (for /force command). */
export function setForceTaskType(type: TaskType): void {
  forceNextType = type;
}

/**
 * Classify a message using Sonnet CLI (native, no API key needed).
 * Falls back to "general" on any error.
 */
export async function classifyTask(text: string): Promise<TaskType> {
  // Check forced override first
  if (forceNextType) {
    const forced = forceNextType;
    forceNextType = null;
    return forced;
  }

  // Check command overrides
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (cmd && cmd in COMMAND_OVERRIDES) {
    return COMMAND_OVERRIDES[cmd]!;
  }

  try {
    const raw = await spawnClassifier(text);
    return parseTaskType(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[classifier] fallback to general: ${msg}`);
    return "general";
  }
}

/** Get the model to use for a given task type. */
export function getModelForTask(taskType: TaskType): string {
  return config.claude.modelRouting[taskType];
}
