import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export interface AlgoResult {
  script: string;
  output: string;
  exitCode: number;
  error?: string;
}

/** Get list of available algo script names. */
export function listScripts(): string[] {
  return Object.keys(config.algo.scripts);
}

/** Run an algo script by name and return its output. */
export async function runAlgoScript(name: string): Promise<AlgoResult> {
  const scriptFile = config.algo.scripts[name];
  if (!scriptFile) {
    return {
      script: name,
      output: "",
      exitCode: 1,
      error: `Unknown script: ${name}. Available: ${listScripts().join(", ")}`,
    };
  }

  const scriptPath = join(config.algo.basePath, scriptFile);

  try {
    const { stdout, stderr } = await execFileAsync(
      config.algo.python,
      [scriptPath],
      {
        timeout: config.algo.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        cwd: config.algo.basePath,
        env: {
          ...process.env,
          PATH: process.env.PATH,
          PYTHONPATH: config.algo.basePath,
        },
      },
    );

    if (stderr) {
      console.error(`[algo] ${name} stderr:`, stderr.slice(0, 500));
    }

    return {
      script: name,
      output: stdout.trim(),
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[algo] ${name} failed:`, msg);

    // execFile error includes stdout/stderr on the error object
    const execErr = err as { stdout?: string; code?: number };
    return {
      script: name,
      output: execErr.stdout?.trim() ?? "",
      exitCode: execErr.code ?? 1,
      error: msg,
    };
  }
}
