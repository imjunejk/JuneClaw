/**
 * Directory-based durable queue with exactly-once processing.
 *
 * Layout:
 *   {baseDir}/pending/      — enqueued, waiting to be claimed
 *   {baseDir}/processing/   — claimed by a worker, in flight
 *   {baseDir}/completed/    — successfully processed
 *   {baseDir}/dead/         — failed after max retries (dead letter queue)
 *
 * Exactly-once claim:
 *   fs.rename() from pending/ → processing/ is atomic on POSIX.
 *   If two workers race to claim the same file, exactly one rename
 *   succeeds; the other gets ENOENT.
 *
 * Crash recovery:
 *   On startup, scan processing/ for orphaned items (worker PID dead).
 *   Move them back to pending/ for reprocessing.
 */

import { readFile, readdir, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";

export interface QueueItem<T = unknown> {
  id: string;
  data: T;
  enqueuedAt: number;
  retryCount: number;
  lastError?: string;
  workerPid?: number;
}

interface QueueOptions {
  baseDir: string;
  maxRetries?: number;
  /** Max completed items to retain (FIFO cleanup) */
  maxCompleted?: number;
}

export class DurableQueue<T = unknown> {
  private dirs: { pending: string; processing: string; completed: string; dead: string };
  private maxRetries: number;
  private maxCompleted: number;
  private initialized = false;

  constructor(private opts: QueueOptions) {
    this.dirs = {
      pending: join(opts.baseDir, "pending"),
      processing: join(opts.baseDir, "processing"),
      completed: join(opts.baseDir, "completed"),
      dead: join(opts.baseDir, "dead"),
    };
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxCompleted = opts.maxCompleted ?? 100;
  }

  private async ensureDirs(): Promise<void> {
    if (this.initialized) return;
    await Promise.all(
      Object.values(this.dirs).map((d) => mkdir(d, { recursive: true })),
    );
    this.initialized = true;
  }

  /** Enqueue a task. Always succeeds (writes to disk). */
  async enqueue(data: T, id?: string): Promise<string> {
    await this.ensureDirs();
    const itemId = id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: QueueItem<T> = {
      id: itemId,
      data,
      enqueuedAt: Date.now(),
      retryCount: 0,
    };
    await atomicWriteJson(join(this.dirs.pending, `${itemId}.json`), item);
    return itemId;
  }

  /**
   * Claim the oldest pending item. Returns null if queue is empty.
   * Uses atomic rename for exactly-once guarantee.
   */
  async claim(): Promise<QueueItem<T> | null> {
    await this.ensureDirs();
    const files = await this.listSorted(this.dirs.pending);
    if (files.length === 0) return null;

    for (const file of files) {
      const src = join(this.dirs.pending, file);
      const dst = join(this.dirs.processing, file);
      try {
        await rename(src, dst);
        // We won the race — read and stamp with our PID
        const raw = await readFile(dst, "utf-8");
        const item = JSON.parse(raw) as QueueItem<T>;
        item.workerPid = process.pid;
        await atomicWriteJson(dst, item);
        return item;
      } catch (err: any) {
        if (err.code === "ENOENT") continue; // Another worker claimed it
        throw err;
      }
    }
    return null;
  }

  /** Mark a claimed item as completed. */
  async complete(id: string): Promise<void> {
    const src = join(this.dirs.processing, `${id}.json`);
    const dst = join(this.dirs.completed, `${id}.json`);
    try {
      await rename(src, dst);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    await this.pruneCompleted();
  }

  /** Release a claimed item back to pending without incrementing retryCount.
   *  Use this for scheduling conflicts (e.g. phone busy), not actual failures. */
  async release(id: string): Promise<void> {
    const src = join(this.dirs.processing, `${id}.json`);
    const dst = join(this.dirs.pending, `${id}.json`);
    try {
      const raw = await readFile(src, "utf-8");
      const item = JSON.parse(raw) as QueueItem<T>;
      item.workerPid = undefined;
      await atomicWriteJson(dst, item);
      await unlink(src).catch(() => {});
    } catch (err: any) {
      // If file is gone, nothing to release
      if (err.code === "ENOENT") return;
      throw err;
    }
  }

  /** Mark a claimed item as failed. Retries or moves to dead letter queue. */
  async fail(id: string, error?: string): Promise<"retried" | "dead"> {
    const path = join(this.dirs.processing, `${id}.json`);
    try {
      const raw = await readFile(path, "utf-8");
      const item = JSON.parse(raw) as QueueItem<T>;
      item.retryCount++;
      item.lastError = error?.slice(0, 500);

      if (item.retryCount >= this.maxRetries) {
        await atomicWriteJson(join(this.dirs.dead, `${id}.json`), item);
        await unlink(path).catch(() => {});
        return "dead";
      }

      // Move back to pending for retry
      item.workerPid = undefined;
      await atomicWriteJson(join(this.dirs.pending, `${id}.json`), item);
      await unlink(path).catch(() => {});
      return "retried";
    } catch (err: any) {
      if (err.code === "ENOENT") return "dead"; // Already cleaned up
      throw err;
    }
  }

  /** Recover orphaned items from processing/ (worker PID dead). */
  async recover(): Promise<number> {
    await this.ensureDirs();
    const files = await this.listSorted(this.dirs.processing);
    let recovered = 0;

    for (const file of files) {
      const path = join(this.dirs.processing, file);
      try {
        const raw = await readFile(path, "utf-8");
        const item = JSON.parse(raw) as QueueItem<T>;

        // Check if worker PID is still alive (no PID = crashed before stamp → orphaned)
        if (item.workerPid && item.workerPid !== process.pid && isProcessAlive(item.workerPid)) continue;

        // Worker is dead — move back to pending
        item.workerPid = undefined;
        await atomicWriteJson(join(this.dirs.pending, file), item);
        await unlink(path).catch(() => {});
        recovered++;
      } catch {
        // Corrupt file — move to dead
        await rename(path, join(this.dirs.dead, file)).catch(() => {});
      }
    }
    return recovered;
  }

  /** Move all processing/ items back to pending/ (graceful shutdown). */
  async abandonAll(): Promise<number> {
    const files = await this.listSorted(this.dirs.processing);
    let count = 0;
    for (const file of files) {
      try {
        await rename(
          join(this.dirs.processing, file),
          join(this.dirs.pending, file),
        );
        count++;
      } catch { /* already moved */ }
    }
    return count;
  }

  /** Number of items in each directory. */
  async stats(): Promise<{ pending: number; processing: number; completed: number; dead: number }> {
    await this.ensureDirs();
    const [p, pr, c, d] = await Promise.all([
      this.listSorted(this.dirs.pending),
      this.listSorted(this.dirs.processing),
      this.listSorted(this.dirs.completed),
      this.listSorted(this.dirs.dead),
    ]);
    return { pending: p.length, processing: pr.length, completed: c.length, dead: d.length };
  }

  /** Peek at pending items without claiming. */
  async pendingCount(): Promise<number> {
    await this.ensureDirs();
    return (await this.listSorted(this.dirs.pending)).length;
  }

  private async listSorted(dir: string): Promise<string[]> {
    try {
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }

  private async pruneCompleted(): Promise<void> {
    const files = await this.listSorted(this.dirs.completed);
    if (files.length <= this.maxCompleted) return;
    const toDelete = files.slice(0, files.length - this.maxCompleted);
    await Promise.all(
      toDelete.map((f) => unlink(join(this.dirs.completed, f)).catch(() => {})),
    );
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
