import { spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.js";

interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

interface ClaudeModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  costUSD: number;
}

interface ClaudeJsonOutput {
  type: string;
  result: string;
  session_id: string;
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: ClaudeUsage;
  modelUsage: Record<string, ClaudeModelUsageEntry>;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  contextTokens: number;
  contextWindow: number;
  usagePercent: number;
  costUSD: number;
  numTurns: number;
}

export interface RunResult {
  response: string;
  sessionId?: string;
  usage?: UsageInfo;
}

function spawnClaude(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claude.bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    // Write prompt via stdin
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
      reject(new Error("TIMEOUT: claude exceeded time limit"));
    }, config.claude.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
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

export async function runClaude(opts: {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;
}): Promise<RunResult> {
  // Write system prompt to temp file to avoid arg length / null byte issues
  const promptDir = join(tmpdir(), "juneclaw");
  await mkdir(promptDir, { recursive: true });
  const promptFile = join(promptDir, `sysprompt-${Date.now()}.md`);
  await writeFile(promptFile, opts.systemPrompt, "utf-8");

  const args = [
    "--print",
    "--permission-mode",
    config.claude.permissionMode,
    "--output-format",
    "json",
    "--append-system-prompt-file",
    promptFile,
    "--allowedTools",
    config.claude.allowedTools.join(" "),
  ];

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  if (config.claude.model) {
    args.push("--model", config.claude.model);
  }

  const attempt = async (): Promise<RunResult> => {
    const raw = await spawnClaude(args, opts.prompt);
    const parsed = JSON.parse(raw.trim()) as ClaudeJsonOutput;

    if (parsed.is_error) {
      throw new Error(`Claude returned error: ${parsed.result}`);
    }

    // Extract usage info from modelUsage (has contextWindow) or fallback to usage
    let usage: UsageInfo | undefined;
    const modelEntry = Object.values(parsed.modelUsage ?? {})[0];
    if (modelEntry) {
      // Context usage = input tokens only (output tokens don't consume context window)
      const contextTokens =
        modelEntry.inputTokens +
        modelEntry.cacheReadInputTokens +
        modelEntry.cacheCreationInputTokens;
      const totalTokens = contextTokens + modelEntry.outputTokens;
      usage = {
        inputTokens: modelEntry.inputTokens,
        outputTokens: modelEntry.outputTokens,
        cacheReadTokens: modelEntry.cacheReadInputTokens,
        cacheCreationTokens: modelEntry.cacheCreationInputTokens,
        totalTokens,
        contextTokens,
        contextWindow: modelEntry.contextWindow,
        usagePercent: modelEntry.contextWindow > 0
          ? (contextTokens / modelEntry.contextWindow) * 100
          : 0,
        costUSD: parsed.total_cost_usd ?? modelEntry.costUSD,
        numTurns: parsed.num_turns ?? 1,
      };
    } else if (parsed.usage) {
      const u = parsed.usage;
      const contextTokens =
        u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      const totalTokens = contextTokens + u.output_tokens;
      usage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheCreationTokens: u.cache_creation_input_tokens,
        totalTokens,
        contextTokens,
        contextWindow: 0,
        usagePercent: 0,
        costUSD: parsed.total_cost_usd ?? 0,
        numTurns: parsed.num_turns ?? 1,
      };
    }

    return {
      response: parsed.result,
      sessionId: parsed.session_id,
      usage,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("TIMEOUT")) {
      return await attempt();
    }
    throw err;
  } finally {
    // Clean up temp file
    unlink(promptFile).catch(() => {});
  }
}
