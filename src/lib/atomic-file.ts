/**
 * Atomic file write using the write-rename pattern.
 *
 * 1. Write to a temp file (same directory, PID-stamped name)
 * 2. fs.rename() into place (atomic on same filesystem — POSIX guarantee)
 * 3. On error, clean up the temp file
 *
 * This ensures readers never see a partially-written file.
 */

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let counter = 0;

function tmpPath(target: string): string {
  return `${target}.${process.pid}.${++counter}.tmp`;
}

export async function atomicWriteFile(
  path: string,
  data: string,
  options?: { encoding?: BufferEncoding; mode?: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tmpPath(path);
  try {
    await writeFile(tmp, data, {
      encoding: options?.encoding ?? "utf-8",
      mode: options?.mode,
    });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function atomicWriteJson(
  path: string,
  data: unknown,
  options?: { mode?: number },
): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(data, null, 2), options);
}
