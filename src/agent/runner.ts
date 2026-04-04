import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

interface ClaudeJsonOutput {
  type: string;
  result: string;
  session_id: string;
  is_error: boolean;
  duration_ms: number;
}

export interface RunResult {
  response: string;
  sessionId?: string;
}

export async function runClaude(opts: {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;
}): Promise<RunResult> {
  const args = [
    "--print",
    "--permission-mode",
    config.claude.permissionMode,
    "--output-format",
    "json",
    "--system-prompt",
    opts.systemPrompt,
    "--allowedTools",
    config.claude.allowedTools.join(","),
  ];

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  if (config.claude.model) {
    args.push("--model", config.claude.model);
  }

  args.push(opts.prompt);

  const attempt = async (): Promise<RunResult> => {
    const { stdout } = await execFileAsync(config.claude.bin, args, {
      timeout: config.claude.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });

    const parsed = JSON.parse(stdout.trim()) as ClaudeJsonOutput;

    if (parsed.is_error) {
      throw new Error(`Claude returned error: ${parsed.result}`);
    }

    return {
      response: parsed.result,
      sessionId: parsed.session_id,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    // Retry once on timeout
    if (err instanceof Error && err.message.includes("TIMEOUT")) {
      return await attempt();
    }
    throw err;
  }
}
