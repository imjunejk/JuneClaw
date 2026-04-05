import cron from "node-cron";

export interface CronJob {
  name: string;
  schedule: string;
  task: cron.ScheduledTask;
  running: boolean;
}

const jobs = new Map<string, CronJob>();
const executing = new Set<string>();

/** Default max execution time per cron job (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Per-job timeout overrides (ms). */
const JOB_TIMEOUTS: Record<string, number> = {
  heartbeat: 5 * 60_000,       // 5 min
  lessonsLoop: 15 * 60_000,    // 15 min
  weeklyCompression: 15 * 60_000,
  monthlyCompression: 15 * 60_000,
};

/**
 * Add and start a cron job. Replaces existing job with same name.
 * - Concurrency guard: skips invocation if the previous run is still executing.
 * - Timeout: kills the callback if it exceeds the allowed duration.
 */
export function addJob(
  name: string,
  schedule: string,
  callback: () => void | Promise<void>,
): void {
  // Remove existing job with same name
  removeJob(name);

  const timeoutMs = JOB_TIMEOUTS[name] ?? DEFAULT_TIMEOUT_MS;

  const task = cron.schedule(
    schedule,
    () => {
      // Concurrency guard: skip if already executing
      if (executing.has(name)) {
        console.warn(`[cron] job "${name}" still running — skipping this invocation`);
        return;
      }
      executing.add(name);
      const start = Date.now();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`[cron] job "${name}" timed out after ${timeoutMs}ms — releasing lock`);
        executing.delete(name);
      }, timeoutMs);

      Promise.resolve(callback())
        .catch((err) => {
          if (!timedOut) {
            console.error(`[cron] job "${name}" failed:`, err);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (!timedOut) {
            executing.delete(name);
            console.log(`[cron] job "${name}" finished in ${Date.now() - start}ms`);
          } else {
            console.warn(`[cron] job "${name}" completed late (after timeout) in ${Date.now() - start}ms — ignored`);
          }
        });
    },
    { timezone: "America/Los_Angeles" },
  );

  jobs.set(name, { name, schedule, task, running: true });
}

/** Stop and remove a cron job by name. */
export function removeJob(name: string): boolean {
  const job = jobs.get(name);
  if (!job) return false;
  job.task.stop();
  jobs.delete(name);
  return true;
}

/** List all registered cron jobs. */
export function listJobs(): Array<{ name: string; schedule: string; running: boolean }> {
  return Array.from(jobs.values()).map(({ name, schedule, running }) => ({
    name,
    schedule,
    running,
  }));
}

/** Stop all cron jobs (for graceful shutdown). */
export function stopAll(): void {
  for (const job of jobs.values()) {
    job.task.stop();
  }
  jobs.clear();
}
