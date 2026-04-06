/**
 * In-process async concurrency primitives.
 * Pure Node.js — zero dependencies.
 *
 * AsyncMutex: serialize access to a shared resource (file, state)
 * Semaphore:  bound concurrent access (worker pool)
 */

export class AsyncMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!();
    } else {
      this.locked = false;
    }
  }

  /** Run fn while holding the lock. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.current--;
    if (this.queue.length > 0 && this.current < this.max) {
      this.current++;
      this.queue.shift()!();
    }
  }

  get available(): number {
    return this.max - this.current;
  }

  get active(): number {
    return this.current;
  }

  get pending(): number {
    return this.queue.length;
  }
}
