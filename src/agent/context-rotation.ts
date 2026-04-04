import { config } from "../config.js";
import { clearSessionId } from "./session.js";
import { writeHandoff } from "../memory/handoff.js";
import { appendDailyLog, appendSystemLog } from "../memory/writer.js";

export type RotationReason =
  | "consecutive_errors"
  | "task_failures"
  | "message_count"
  | "context_full";

interface ChannelRotationState {
  consecutiveErrors: number;
  taskFailures: Map<string, number>;
  messageCount: number;
  lastRotatedAt: string | null;
}

const states = new Map<string, ChannelRotationState>();

function getState(phone: string): ChannelRotationState {
  let s = states.get(phone);
  if (!s) {
    s = {
      consecutiveErrors: 0,
      taskFailures: new Map(),
      messageCount: 0,
      lastRotatedAt: null,
    };
    states.set(phone, s);
  }
  return s;
}

export function recordError(phone: string): void {
  const s = getState(phone);
  s.consecutiveErrors++;
}

export function recordSuccess(phone: string): void {
  const s = getState(phone);
  s.consecutiveErrors = 0;
}

export function recordTaskFailure(phone: string, taskId: string): void {
  const s = getState(phone);
  const count = (s.taskFailures.get(taskId) ?? 0) + 1;
  s.taskFailures.set(taskId, count);
}

export function recordMessage(phone: string): void {
  const s = getState(phone);
  s.messageCount++;
}

export function recordContextFull(phone: string): void {
  const s = getState(phone);
  s.consecutiveErrors = config.contextRotation.maxConsecutiveErrors;
}

export function shouldRotate(phone: string): RotationReason | null {
  const s = getState(phone);
  const { maxConsecutiveErrors, maxTaskFailures, messageCountForceRotate } =
    config.contextRotation;

  if (s.consecutiveErrors >= maxConsecutiveErrors) return "consecutive_errors";

  for (const count of s.taskFailures.values()) {
    if (count >= maxTaskFailures) return "task_failures";
  }

  if (s.messageCount >= messageCountForceRotate) return "message_count";

  return null;
}

export function getMessageCount(phone: string): number {
  return getState(phone).messageCount;
}

export async function executeRotation(
  phone: string,
  reason: RotationReason,
): Promise<void> {
  const s = getState(phone);

  await writeHandoff({
    reason: `context rotation: ${reason}`,
    progress: `Messages in session: ${s.messageCount}, errors: ${s.consecutiveErrors}`,
  });

  await clearSessionId(phone);

  await appendSystemLog(
    `Context rotation for ${phone}: ${reason} (msgs=${s.messageCount}, errs=${s.consecutiveErrors})`,
  );

  await appendDailyLog(
    "System",
    `[context-rotation] ${reason}`,
    `Session rotated. Messages: ${s.messageCount}, Errors: ${s.consecutiveErrors}`,
  );

  // Reset counters
  s.consecutiveErrors = 0;
  s.taskFailures.clear();
  s.messageCount = 0;
  s.lastRotatedAt = new Date().toISOString();
}
