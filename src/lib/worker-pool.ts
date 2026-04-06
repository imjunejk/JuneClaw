/**
 * Semaphore-gated worker pool for AI agent subprocess management.
 *
 * - Bounds concurrent Claude CLI spawns (default: 2)
 * - Tracks active workers with metadata (taskType, startTime)
 * - Graceful drain on shutdown (waits for in-flight workers)
 * - Fire-and-forget submit: caller doesn't block on worker completion
 */

import { Semaphore } from "./async-mutex.js";

export interface WorkerMeta {
  id: string;
  taskType: string;
  startedAt: number;
  description: string;
}

type WorkerFn = () => Promise<void>;

interface PoolOptions {
  maxWorkers: number;
  /** Callback when a worker completes */
  onComplete?: (meta: WorkerMeta, error?: Error) => void;
}

export class WorkerPool {
  private semaphore: Semaphore;
  private activeWorkers = new Map<string, WorkerMeta>();
  private onComplete: PoolOptions["onComplete"];
  private drainResolvers: (() => void)[] = [];

  constructor(opts: PoolOptions) {
    this.semaphore = new Semaphore(opts.maxWorkers);
    this.onComplete = opts.onComplete;
  }

  /** True if the pool can accept more work. */
  hasCapacity(): boolean {
    return this.semaphore.available > 0;
  }

  /**
   * Submit work to the pool. Blocks only until a semaphore slot opens,
   * then runs the worker in the background (fire-and-forget).
   * Returns the worker ID.
   */
  async submit(
    fn: WorkerFn,
    meta: Omit<WorkerMeta, "id" | "startedAt">,
  ): Promise<string> {
    await this.semaphore.acquire();

    const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const workerMeta: WorkerMeta = {
      id,
      ...meta,
      startedAt: Date.now(),
    };
    this.activeWorkers.set(id, workerMeta);

    // Fire-and-forget — release semaphore when done
    this.runWorker(id, fn, workerMeta).catch(() => {});

    return id;
  }

  private async runWorker(id: string, fn: WorkerFn, meta: WorkerMeta): Promise<void> {
    let error: Error | undefined;
    try {
      await fn();
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.activeWorkers.delete(id);
      this.semaphore.release();
      this.onComplete?.(meta, error);

      // Resolve drain waiters if pool is now empty
      if (this.activeWorkers.size === 0 && this.drainResolvers.length > 0) {
        for (const resolve of this.drainResolvers.splice(0)) {
          resolve();
        }
      }
    }
  }

  /** Wait for all active workers to complete (with timeout). */
  async drain(timeoutMs = 30_000): Promise<void> {
    if (this.activeWorkers.size === 0) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this resolver and resolve anyway
        const idx = this.drainResolvers.indexOf(resolve);
        if (idx >= 0) this.drainResolvers.splice(idx, 1);
        resolve();
      }, timeoutMs);

      this.drainResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  get activeCount(): number {
    return this.activeWorkers.size;
  }

  get pendingCount(): number {
    return this.semaphore.pending;
  }

  getActiveWorkers(): WorkerMeta[] {
    return Array.from(this.activeWorkers.values());
  }
}
