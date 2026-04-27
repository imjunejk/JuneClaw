/**
 * External cron jobs loaded from `~/.juneclaw/jobs.d/*.json`.
 *
 * Each JSON file contains one or more job specs. The daemon scans the
 * directory on startup, registers every job with the cron scheduler, and
 * watches the directory for changes — files can be added, edited, or
 * removed without restarting the daemon.
 *
 * Why this exists: cron jobs that invoke `claude` from system crontab can't
 * read OAuth tokens from macOS Keychain. Running them under the JuneClaw
 * daemon (user session) avoids that. Hardcoding each external job into
 * daemon.ts would be a maintenance trap, so we accept declarative specs
 * from external repos.
 */

import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, readFile, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AsyncMutex } from "../lib/async-mutex.js";
import { emit } from "../hooks/events.js";
import { appendSystemLog } from "../memory/writer.js";

const execFileAsync = promisify(execFile);

// ── Schema ───────────────────────────────────────────────────

const JobSpecSchema = z.object({
  /** Globally unique job name (lowercase, dash-separated). */
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  /** Cron expression. node-cron validates it on register. */
  schedule: z.string().min(1),
  /** Argv array — first element is the binary, rest are args. Resolved relative to cwd if not absolute. */
  command: z.array(z.string()).min(1),
  /** Absolute working directory. */
  cwd: z.string().refine(isAbsolute, "cwd must be absolute"),
  /** Optional .env file. Resolved relative to cwd if not absolute. */
  envFile: z.string().optional(),
  /** Extra env vars merged on top of process.env (and after envFile). */
  env: z.record(z.string(), z.string()).optional(),
  /** Hard kill after this many ms. Default 10 min. */
  timeoutMs: z.number().int().positive().default(10 * 60_000),
  /** If set, append stdout+stderr to this file (relative to cwd or absolute). */
  logFile: z.string().optional(),
  /** Optional argv to run after the main command exits 0. Skipped on failure. */
  postCommand: z.array(z.string()).optional(),
  /** cwd for postCommand. Defaults to spec.cwd. */
  postCommandCwd: z.string().optional(),
  /** Hard kill for postCommand. Default 10 min. */
  postCommandTimeoutMs: z.number().int().positive().default(10 * 60_000),
});

const JobSpecFileSchema = z.object({
  jobs: z.array(JobSpecSchema).min(1),
});

export type JobSpec = z.infer<typeof JobSpecSchema>;

// ── Loader ───────────────────────────────────────────────────

export interface LoadResult {
  /** filename → list of job names defined in that file */
  owners: Map<string, string[]>;
  /** flat list of all valid job specs (after dedupe) */
  jobs: JobSpec[];
  /** non-fatal issues encountered during load */
  warnings: string[];
}

/**
 * Parse one job spec file. Returns the parsed jobs or a thrown error
 * (with formatted Zod issues if validation failed).
 */
export async function loadJobSpecFile(filePath: string): Promise<JobSpec[]> {
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = JobSpecFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`schema validation failed: ${issues}`);
  }
  return result.data.jobs;
}

/**
 * Scan a directory for *.json job spec files and return all valid jobs.
 * Files are processed in lexical filename order so duplicate-name resolution
 * is deterministic (first wins).
 */
export async function loadAllExternalJobs(dir: string): Promise<LoadResult> {
  const owners = new Map<string, string[]>();
  const jobs: JobSpec[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];

  if (!existsSync(dir)) {
    return { owners, jobs, warnings };
  }

  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".json")).sort();

  for (const file of files) {
    const fullPath = join(dir, file);
    try {
      const fileJobs = await loadJobSpecFile(fullPath);
      const accepted: string[] = [];
      for (const job of fileJobs) {
        if (seen.has(job.name)) {
          warnings.push(`duplicate job name "${job.name}" in ${file} — skipped (already registered from earlier file)`);
          continue;
        }
        seen.add(job.name);
        jobs.push(job);
        accepted.push(job.name);
      }
      if (accepted.length > 0) owners.set(file, accepted);
    } catch (err) {
      warnings.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { owners, jobs, warnings };
}

// ── Executor ─────────────────────────────────────────────────

/** Quote a single argv element for safe inclusion in a bash one-liner. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildBashCommand(
  command: string[],
  envFile: string | undefined,
  cwd: string,
): string {
  const quoted = command.map(shellQuote).join(" ");
  if (!envFile) return quoted;
  const envPath = isAbsolute(envFile) ? envFile : join(cwd, envFile);
  return `set -a && source ${shellQuote(envPath)} && set +a && ${quoted}`;
}

/**
 * Run a single command (main or post) under bash, capture output,
 * append to logFile if provided, and return last-3-line summary.
 */
async function runCommand(opts: {
  command: string[];
  cwd: string;
  envFile?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  logFile?: string;
  label: string;
}): Promise<{ tail: string; stderrPreview: string }> {
  const bashCmd = buildBashCommand(opts.command, opts.envFile, opts.cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const { stdout, stderr } = await execFileAsync("bash", ["-c", bashCmd], {
    cwd: opts.cwd,
    env,
    timeout: opts.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (opts.logFile) {
    const logPath = isAbsolute(opts.logFile) ? opts.logFile : join(opts.cwd, opts.logFile);
    const ts = new Date().toISOString();
    const stamped = `\n--- ${ts} [${opts.label}] ---\n${stdout}${stderr ? `\nSTDERR:\n${stderr}` : ""}`;
    try {
      await appendFile(logPath, stamped, "utf-8");
    } catch {
      // logFile dir may not exist or be writable — non-fatal
    }
  }

  const tail = stdout.trim().split("\n").slice(-3).join(" | ");
  const stderrPreview = stderr.trim().slice(0, 300);
  return { tail, stderrPreview };
}

/**
 * Execute a job spec end-to-end: main command, then postCommand on success.
 * Failures throw so the cron scheduler's circuit breaker counts them.
 */
export async function executeJobSpec(spec: JobSpec): Promise<void> {
  const startedAt = Date.now();
  await emit("cron:started", { job: spec.name });

  try {
    const main = await runCommand({
      command: spec.command,
      cwd: spec.cwd,
      envFile: spec.envFile,
      env: spec.env,
      timeoutMs: spec.timeoutMs,
      logFile: spec.logFile,
      label: "main",
    });
    console.log(`[external-job] "${spec.name}" main: ${main.tail || "(no stdout)"}`);
    if (main.stderrPreview) {
      console.log(`[external-job] "${spec.name}" main stderr: ${main.stderrPreview}`);
    }

    if (spec.postCommand && spec.postCommand.length > 0) {
      const post = await runCommand({
        command: spec.postCommand,
        cwd: spec.postCommandCwd ?? spec.cwd,
        // postCommand inherits env from process — does NOT re-source envFile
        // (different cwd typical, e.g., dashboard deploy script). Specify
        // env on the spec if vars need to flow through.
        env: spec.env,
        timeoutMs: spec.postCommandTimeoutMs,
        logFile: spec.logFile,
        label: "post",
      });
      console.log(`[external-job] "${spec.name}" post: ${post.tail || "(no stdout)"}`);
      if (post.stderrPreview) {
        console.log(`[external-job] "${spec.name}" post stderr: ${post.stderrPreview}`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    await emit("cron:completed", { job: spec.name });
    console.log(`[external-job] "${spec.name}" finished in ${elapsedMs}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendSystemLog(`external-job "${spec.name}" failed: ${msg.slice(0, 300)}`);
    await emit("cron:failed", { job: spec.name, error: msg });
    throw err;
  }
}

// ── Watcher ──────────────────────────────────────────────────

export interface WatcherDeps {
  addJob: (name: string, schedule: string, callback: () => Promise<void>) => void;
  removeJob: (name: string) => boolean;
}

export interface WatcherHandle {
  /** Called on daemon shutdown to release fs.watch + drain in-flight reloads. */
  close: () => Promise<void>;
  /** Force-rescan the directory (useful in tests). */
  reloadAll: () => Promise<void>;
  /** Snapshot of currently-registered job names (useful in tests). */
  registered: () => string[];
}

const RELOAD_DEBOUNCE_MS = 200;

/**
 * Watch a jobs.d directory and keep the cron scheduler in sync with it.
 *
 * On change events we re-scan the entire directory rather than tracking
 * individual files. Re-scans are cheap (single-digit number of small JSON
 * files) and avoid edge cases around fs.watch event delivery (rename vs
 * change is unreliable across platforms). Per-call serialization via mutex
 * prevents reentrancy.
 */
export async function startExternalJobsWatcher(
  dir: string,
  deps: WatcherDeps,
): Promise<WatcherHandle> {
  const reloadMutex = new AsyncMutex();
  let registered = new Map<string, JobSpec>(); // name → spec
  let watcher: FSWatcher | null = null;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  async function reload(): Promise<void> {
    await reloadMutex.run(async () => {
      if (closed) return;
      const { jobs, warnings } = await loadAllExternalJobs(dir);
      const next = new Map(jobs.map((j) => [j.name, j]));

      // Remove jobs that disappeared or whose schedule changed
      for (const [name, prev] of registered) {
        const incoming = next.get(name);
        if (!incoming || incoming.schedule !== prev.schedule) {
          deps.removeJob(name);
        }
      }

      // Add or replace
      for (const [name, spec] of next) {
        const prev = registered.get(name);
        if (prev && prev.schedule === spec.schedule) {
          // schedule unchanged — still re-bind so the closure captures the
          // latest spec (command/env may have changed). addJob's removeJob
          // upfront makes this a no-op when called twice.
        }
        deps.addJob(name, spec.schedule, () => executeJobSpec(spec));
      }

      registered = next;

      const summary = `external jobs: ${registered.size} active (${[...registered.keys()].sort().join(", ") || "none"})`;
      console.log(`[external-jobs] ${summary}`);
      if (warnings.length > 0) {
        for (const w of warnings) {
          console.warn(`[external-jobs] ${w}`);
        }
        await appendSystemLog(`external-jobs warnings: ${warnings.join(" | ")}`);
      }
    });
  }

  function scheduleReload(filename: string | null): void {
    const key = filename ?? "_dir_";
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      reload().catch((err) => {
        console.error(`[external-jobs] reload failed:`, err);
      });
    }, RELOAD_DEBOUNCE_MS);
    debounceTimers.set(key, timer);
  }

  // Initial load — surface fatal errors to caller (e.g., dir read perms).
  await reload();

  if (existsSync(dir)) {
    try {
      watcher = fsWatch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename && !filename.endsWith(".json")) return;
        scheduleReload(filename);
      });
    } catch (err) {
      // Watching is a nice-to-have; daemon continues with the initial load.
      console.warn(`[external-jobs] fs.watch failed (continuing without hot-reload): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    close: async () => {
      closed = true;
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      watcher?.close();
      // Wait for any in-flight reload to finish.
      await reloadMutex.run(async () => {});
    },
    reloadAll: reload,
    registered: () => [...registered.keys()].sort(),
  };
}

// Re-export schema for tests / external tooling.
export { JobSpecSchema, JobSpecFileSchema };

// dirname is imported for completeness — a future enhancement may resolve
// command[0] relative to cwd if not absolute.
void dirname;
