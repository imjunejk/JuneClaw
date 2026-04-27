import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted state lets the vi.mock factory and tests share a single ref
// to the captured fs.watch listener.
const { watchListeners } = vi.hoisted(() => ({
  watchListeners: [] as Array<(eventType: string, filename: string | null) => void>,
}));

// Mock child_process so we never spawn real bash.
// Note: external-jobs.ts wraps execFile with util.promisify. Our mock doesn't
// have the [promisify.custom] symbol that Node's real execFile carries, so
// default promisify resolves to whatever the second callback arg is. We pass
// a `{stdout, stderr}` object to match what runCommand destructures.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock node:fs to intercept `watch`. Other fs APIs (existsSync, etc.) keep
// their real implementations so loadAllExternalJobs can read the tmpdir.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: (..._args: unknown[]) => {
      // node:fs.watch supports both (path, listener) and (path, opts, listener) — the
      // listener is always the last function argument.
      const last = _args[_args.length - 1];
      if (typeof last === "function") {
        watchListeners.push(last as (e: string, f: string | null) => void);
      }
      return { close: () => {} };
    },
  };
});

// Mock event emitter + system log so tests don't touch disk.
vi.mock("../hooks/events.js", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../memory/writer.js", () => ({
  appendSystemLog: vi.fn().mockResolvedValue(undefined),
}));

import {
  loadJobSpecFile,
  loadAllExternalJobs,
  executeJobSpec,
  startExternalJobsWatcher,
  JobSpecSchema,
} from "./external-jobs.js";
import { execFile } from "node:child_process";
import { emit } from "../hooks/events.js";

const validSpec = {
  name: "test-job",
  schedule: "0 * * * *",
  command: ["echo", "hi"],
  cwd: "/tmp",
};

let tmpDir: string;

type ExecFileMock = ReturnType<typeof vi.fn>;
function setExecFileSuccess(stdout = "stdout-line-1\nstdout-line-2\nstdout-line-3", stderr = ""): void {
  (execFile as unknown as ExecFileMock).mockImplementation((_bin: string, _args: string[], _opts: object, cb: (err: Error | null, value: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout, stderr });
    return { kill: () => {} };
  });
}
function setExecFileFailure(message = "main failed", stderr = "boom"): void {
  (execFile as unknown as ExecFileMock).mockImplementation((_bin: string, _args: string[], _opts: object, cb: (err: Error | null, value: { stdout: string; stderr: string }) => void) => {
    const err = new Error(message) as Error & { stdout?: string; stderr?: string };
    err.stdout = "";
    err.stderr = stderr;
    cb(err, { stdout: "", stderr });
    return { kill: () => {} };
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "juneclaw-jobs-"));
  vi.clearAllMocks();
  watchListeners.length = 0;
  setExecFileSuccess();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("JobSpecSchema", () => {
  it("accepts a minimal valid spec", () => {
    const result = JobSpecSchema.safeParse(validSpec);
    expect(result.success).toBe(true);
  });

  it("rejects a non-absolute cwd", () => {
    const result = JobSpecSchema.safeParse({ ...validSpec, cwd: "relative/path" });
    expect(result.success).toBe(false);
  });

  it("rejects names with invalid characters", () => {
    const result = JobSpecSchema.safeParse({ ...validSpec, name: "Bad Name" });
    expect(result.success).toBe(false);
  });

  it("requires command to have at least one element", () => {
    const result = JobSpecSchema.safeParse({ ...validSpec, command: [] });
    expect(result.success).toBe(false);
  });

  it("applies default timeoutMs when omitted", () => {
    const result = JobSpecSchema.parse(validSpec);
    expect(result.timeoutMs).toBe(10 * 60_000);
  });
});

describe("loadJobSpecFile", () => {
  it("parses a valid file", async () => {
    const f = join(tmpDir, "valid.json");
    writeFileSync(f, JSON.stringify({ jobs: [validSpec] }));
    const jobs = await loadJobSpecFile(f);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe("test-job");
  });

  it("throws on invalid JSON", async () => {
    const f = join(tmpDir, "bad.json");
    writeFileSync(f, "{ not json");
    await expect(loadJobSpecFile(f)).rejects.toThrow(/invalid JSON/);
  });

  it("throws on schema failure with formatted issues", async () => {
    const f = join(tmpDir, "bad-schema.json");
    writeFileSync(f, JSON.stringify({ jobs: [{ name: "x" }] }));
    await expect(loadJobSpecFile(f)).rejects.toThrow(/schema validation failed/);
  });
});

describe("loadAllExternalJobs", () => {
  it("returns empty result when directory does not exist", async () => {
    const result = await loadAllExternalJobs(join(tmpDir, "nonexistent"));
    expect(result.jobs).toEqual([]);
    expect(result.owners.size).toBe(0);
  });

  it("loads multiple files in lexical order", async () => {
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "from-b" }] }));
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "from-a" }] }));
    const result = await loadAllExternalJobs(tmpDir);
    expect(result.jobs.map((j) => j.name)).toEqual(["from-a", "from-b"]);
  });

  it("first wins on duplicate name across files; warning emitted", async () => {
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "dup", schedule: "* * * * *" }] }));
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "dup", schedule: "0 0 * * *" }] }));
    const result = await loadAllExternalJobs(tmpDir);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.schedule).toBe("* * * * *");
    expect(result.warnings.some((w) => w.includes("duplicate") && w.includes("b.json"))).toBe(true);
  });

  it("skips invalid files but still loads valid ones", async () => {
    writeFileSync(join(tmpDir, "good.json"), JSON.stringify({ jobs: [validSpec] }));
    writeFileSync(join(tmpDir, "bad.json"), "{ not json");
    const result = await loadAllExternalJobs(tmpDir);
    expect(result.jobs).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("bad.json"))).toBe(true);
  });

  it("ignores non-.json files in the directory", async () => {
    writeFileSync(join(tmpDir, "valid.json"), JSON.stringify({ jobs: [validSpec] }));
    writeFileSync(join(tmpDir, "README.md"), "# notes");
    const result = await loadAllExternalJobs(tmpDir);
    expect(result.jobs).toHaveLength(1);
  });
});

describe("executeJobSpec", () => {
  it("invokes bash -c with quoted command and no envFile prefix", async () => {
    await executeJobSpec(JobSpecSchema.parse(validSpec));
    const calls = (execFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [bin, args] = calls[0]!;
    expect(bin).toBe("bash");
    expect((args as string[])[0]).toBe("-c");
    expect((args as string[])[1]).toContain("'echo' 'hi'");
    expect((args as string[])[1]).not.toContain("source ");
  });

  it("prefixes envFile sourcing when envFile is set", async () => {
    await executeJobSpec(JobSpecSchema.parse({ ...validSpec, envFile: ".env" }));
    const args = (execFile as unknown as { mock: { calls: [unknown, unknown[]][] } }).mock.calls[0]![1] as string[];
    expect(args[1]).toMatch(/^set -a && source '\/tmp\/\.env' && set \+a && /);
  });

  it("runs postCommand only when main succeeds", async () => {
    const spec = JobSpecSchema.parse({ ...validSpec, postCommand: ["bash", "deploy.sh"] });
    await executeJobSpec(spec);
    const calls = (execFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(2); // main + post
  });

  it("does NOT run postCommand when main fails", async () => {
    setExecFileFailure();
    const spec = JobSpecSchema.parse({ ...validSpec, postCommand: ["bash", "deploy.sh"] });
    await expect(executeJobSpec(spec)).rejects.toThrow(/main failed/);
    const calls = (execFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1); // post never ran
  });

  it("appends partial output to logFile even when the command fails", async () => {
const logPath = join(tmpDir, "job.log");
    setExecFileFailure("timeout", "stderr from failed run");
    const spec = JobSpecSchema.parse({
      ...validSpec,
      cwd: tmpDir, // must be absolute; tmpDir is fine
      logFile: "job.log",
    });
    await expect(executeJobSpec(spec)).rejects.toThrow(/timeout/);
    const written = readFileSync(logPath, "utf-8");
    expect(written).toContain("[main] [FAILED]");
    expect(written).toContain("stderr from failed run");
  });

  it("appends successful output to logFile with [OK] label", async () => {
    const logPath = join(tmpDir, "ok.log");
    const spec = JobSpecSchema.parse({
      ...validSpec,
      cwd: tmpDir,
      logFile: "ok.log",
    });
    await executeJobSpec(spec);
    const written = readFileSync(logPath, "utf-8");
    expect(written).toContain("[main] [OK]");
    expect(written).toContain("stdout-line-1");
  });

  it("auto-creates the logFile parent directory if missing", async () => {
    const nestedDir = join(tmpDir, "deep", "nested");
    const logPath = join(nestedDir, "job.log");
    const spec = JobSpecSchema.parse({
      ...validSpec,
      cwd: tmpDir,
      logFile: join("deep", "nested", "job.log"),
    });
    await executeJobSpec(spec);
    const written = readFileSync(logPath, "utf-8");
    expect(written).toContain("[main] [OK]");
  });

  it("postCommand failure is non-fatal by default (matches original gwangsuAdvice semantics)", async () => {
    // Main succeeds, post fails — executeJobSpec must resolve (not throw)
    let callCount = 0;
    (execFile as unknown as ExecFileMock).mockImplementation(
      (_bin: string, _args: string[], _opts: object, cb: (err: Error | null, value: { stdout: string; stderr: string }) => void) => {
        callCount++;
        if (callCount === 1) {
          cb(null, { stdout: "advice generated", stderr: "" });
        } else {
          const err = new Error("deploy failed") as Error & { stdout?: string; stderr?: string };
          err.stdout = "";
          err.stderr = "wrangler error";
          cb(err, { stdout: "", stderr: "wrangler error" });
        }
        return { kill: () => {} };
      },
    );
    const spec = JobSpecSchema.parse({ ...validSpec, postCommand: ["bash", "deploy.sh"] });
    await expect(executeJobSpec(spec)).resolves.toBeUndefined();
    const calls = (execFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(2); // both main + post ran
  });

  it("postCommand failure is fatal when postCommandFailIsFatal: true", async () => {
    let callCount = 0;
    (execFile as unknown as ExecFileMock).mockImplementation(
      (_bin: string, _args: string[], _opts: object, cb: (err: Error | null, value: { stdout: string; stderr: string }) => void) => {
        callCount++;
        if (callCount === 1) {
          cb(null, { stdout: "main ok", stderr: "" });
        } else {
          const err = new Error("post failed") as Error & { stdout?: string; stderr?: string };
          err.stdout = "";
          err.stderr = "boom";
          cb(err, { stdout: "", stderr: "boom" });
        }
        return { kill: () => {} };
      },
    );
    const spec = JobSpecSchema.parse({
      ...validSpec,
      postCommand: ["bash", "must-succeed.sh"],
      postCommandFailIsFatal: true,
    });
    await expect(executeJobSpec(spec)).rejects.toThrow(/post failed/);
  });
});

describe("startExternalJobsWatcher", () => {
  it("registers all valid jobs on startup", async () => {
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "a-job" }] }));
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "b-job" }] }));

    const addJob = vi.fn();
    const removeJob = vi.fn();
    const handle = await startExternalJobsWatcher(tmpDir, { addJob, removeJob });

    expect(addJob).toHaveBeenCalledTimes(2);
    expect(handle.registered()).toEqual(["a-job", "b-job"]);
    await handle.close();
  });

  it("reloadAll re-registers jobs after spec changes (schedule diff triggers removeJob)", async () => {
    const f = join(tmpDir, "spec.json");
    writeFileSync(f, JSON.stringify({ jobs: [{ ...validSpec, name: "evolving", schedule: "0 6 * * *" }] }));

    const addJob = vi.fn();
    const removeJob = vi.fn();
    const handle = await startExternalJobsWatcher(tmpDir, { addJob, removeJob });
    expect(addJob).toHaveBeenCalledTimes(1);
    expect(removeJob).not.toHaveBeenCalled();

    // Change the schedule and re-scan
    writeFileSync(f, JSON.stringify({ jobs: [{ ...validSpec, name: "evolving", schedule: "0 12 * * *" }] }));
    await handle.reloadAll();

    expect(removeJob).toHaveBeenCalledWith("evolving");
    expect(addJob).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it("removes jobs whose spec file is deleted", async () => {
    const f = join(tmpDir, "ephemeral.json");
    writeFileSync(f, JSON.stringify({ jobs: [{ ...validSpec, name: "ephemeral" }] }));

    const addJob = vi.fn();
    const removeJob = vi.fn();
    const handle = await startExternalJobsWatcher(tmpDir, { addJob, removeJob });
    expect(handle.registered()).toEqual(["ephemeral"]);

    rmSync(f);
    await handle.reloadAll();

    expect(removeJob).toHaveBeenCalledWith("ephemeral");
    expect(handle.registered()).toEqual([]);
    await handle.close();
  });

  it("handles missing directory gracefully (no jobs, no crash)", async () => {
    const addJob = vi.fn();
    const removeJob = vi.fn();
    const handle = await startExternalJobsWatcher(join(tmpDir, "does-not-exist"), { addJob, removeJob });
    expect(addJob).not.toHaveBeenCalled();
    expect(handle.registered()).toEqual([]);
    await handle.close();
  });
});

describe("buildBashCommand quoting", () => {
  it("escapes single quotes in arg values", async () => {
    const spec = JobSpecSchema.parse({ ...validSpec, command: ["echo", "it's fine"] });
    await executeJobSpec(spec);
    const args = (execFile as unknown as { mock: { calls: [unknown, unknown[]][] } }).mock.calls[0]![1] as string[];
    // 'it'\''s fine' is the safe form
    expect(args[1]).toContain(`'it'\\''s fine'`);
  });
});

describe("fs.watch integration", () => {
  // Uses real timers — fake timers don't synchronize with libuv's fs thread
  // pool callbacks that the reload triggers.
  it("debounces fs.watch events into a single coalesced reload", async () => {
    writeFileSync(join(tmpDir, "a.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "a-job" }] }));

    const addJob = vi.fn();
    const removeJob = vi.fn();
    const handle = await startExternalJobsWatcher(tmpDir, { addJob, removeJob });
    expect(addJob).toHaveBeenCalledTimes(1); // initial load
    expect(watchListeners.length).toBe(1); // watcher attached

    // Add a second spec file, then fire several watch events in quick
    // succession. Per-filename debouncing would re-scan twice; the
    // single-key implementation must coalesce into one reload.
    writeFileSync(join(tmpDir, "b.json"), JSON.stringify({ jobs: [{ ...validSpec, name: "b-job" }] }));
    const listener = watchListeners[0]!;
    listener("change", "a.json");
    listener("change", "b.json");
    listener("rename", "b.json");

    // Wait past 200ms debounce + a small margin for async I/O completion.
    await new Promise((r) => setTimeout(r, 350));

    // Reload re-binds every spec (a-job still there + b-job new) → +2 addJob calls
    expect(addJob).toHaveBeenCalledTimes(3);
    expect(handle.registered()).toEqual(["a-job", "b-job"]);

    await handle.close();
  });
});

describe("emit failure resilience", () => {
  it("does not turn a successful job into a failure when emit() throws", async () => {
    (emit as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("hook handler exploded"));
    const spec = JobSpecSchema.parse(validSpec);
    // Main exec succeeds (default mock), emit throws — executeJobSpec should still resolve.
    await expect(executeJobSpec(spec)).resolves.toBeUndefined();
  });
});

// mkdirSync is imported in case future tests need it; reference to keep TS lint happy.
void mkdirSync;
