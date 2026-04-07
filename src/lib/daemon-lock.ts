/**
 * Exclusive daemon lock using O_EXCL atomic file creation + PID validation.
 *
 * Two-layer approach that eliminates the PID-file race window:
 *
 * Layer 1: Lockfile with O_EXCL (atomic create-or-fail at kernel level)
 *   - If file exists → check if the PID inside is still alive
 *   - If alive → another daemon is running, refuse to start
 *   - If dead → stale lock, remove and retry
 *
 * Layer 2: Periodic liveness write (heartbeat updates mtime)
 *   - The watchdog can use mtime staleness as a secondary health signal
 *
 * On process exit (including crash/SIGKILL), the lock file remains but
 * contains a dead PID, so the next startup cleans it up.
 */

import { open, unlink, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import { constants } from "node:fs";

const LOCK_PATH = config.paths.daemonLock;

export interface DaemonLock {
  /** Release the lock (idempotent). */
  release(): Promise<void>;
  /** Update the lock mtime (call from heartbeat). */
  touch(): Promise<void>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire an exclusive daemon lock.
 * Returns the lock handle on success, or null if another daemon holds it.
 */
export async function tryAcquireDaemonLock(): Promise<DaemonLock | null> {
  await mkdir(dirname(LOCK_PATH), { recursive: true });

  const myPid = String(process.pid);

  // Try to create lock file exclusively (O_CREAT | O_EXCL | O_WRONLY)
  // This is atomic: only one process can succeed.
  try {
    const fh = await open(LOCK_PATH, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await fh.write(myPid);
    await fh.close();
    return makeLock();
  } catch (err: unknown) {
    // EEXIST = lock file already exists
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST")) {
      throw err; // unexpected error
    }
  }

  // Lock file exists — check if the holder is still alive
  let existingPid: number;
  try {
    const content = await readFile(LOCK_PATH, "utf-8");
    existingPid = parseInt(content.trim(), 10);
  } catch {
    // Can't read lock file — try to remove and retry
    await removeStaleLock();
    return tryCreateLock(myPid);
  }

  if (isNaN(existingPid)) {
    // Corrupted lock file
    await removeStaleLock();
    return tryCreateLock(myPid);
  }

  if (existingPid === process.pid) {
    // We already hold the lock (shouldn't happen, but safe)
    return makeLock();
  }

  if (isPidAlive(existingPid)) {
    // Another daemon is alive — refuse
    return null;
  }

  // Stale lock from a dead process — remove and acquire
  await removeStaleLock();
  return tryCreateLock(myPid);
}

async function tryCreateLock(pid: string): Promise<DaemonLock | null> {
  try {
    const fh = await open(LOCK_PATH, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await fh.write(pid);
    await fh.close();
    return makeLock();
  } catch {
    // Another process beat us to it
    return null;
  }
}

async function removeStaleLock(): Promise<void> {
  try {
    await unlink(LOCK_PATH);
  } catch {
    // Already removed
  }
}

function makeLock(): DaemonLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await removeStaleLock();
    },
    async touch() {
      // Rewrite PID to update mtime (watchdog can check staleness)
      try {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(LOCK_PATH, String(process.pid));
      } catch {
        // Best-effort
      }
    },
  };
}
