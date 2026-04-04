import cron from "node-cron";

export interface CronJob {
  name: string;
  schedule: string;
  task: cron.ScheduledTask;
  running: boolean;
}

const jobs = new Map<string, CronJob>();

/**
 * Add and start a cron job. Replaces existing job with same name.
 */
export function addJob(
  name: string,
  schedule: string,
  callback: () => void | Promise<void>,
): void {
  // Remove existing job with same name
  removeJob(name);

  const task = cron.schedule(
    schedule,
    () => {
      Promise.resolve(callback()).catch((err) => {
        console.error(`[cron] job "${name}" failed:`, err);
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
