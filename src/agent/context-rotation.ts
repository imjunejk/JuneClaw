import { config } from "../config.js";
import { clearSessionId } from "./session.js";
import { writeHandoff } from "../memory/handoff.js";
import { appendDailyLog, appendSystemLog } from "../memory/writer.js";
import type { UsageInfo } from "./runner.js";

export type RotationReason =
  | "consecutive_errors"
  | "task_failures"
  | "message_count"
  | "context_full"
  | "token_threshold";

interface ChannelRotationState {
  consecutiveErrors: number;
  taskFailures: Map<string, number>;
  messageCount: number;
  lastRotatedAt: string | null;
  lastUsage: UsageInfo | null;
  peakUsagePercent: number;
  cumulativeTokens: number;
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
      lastUsage: null,
      peakUsagePercent: 0,
      cumulativeTokens: 0,
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

export function recordUsage(phone: string, usage: UsageInfo): void {
  const s = getState(phone);
  s.lastUsage = usage;
  s.cumulativeTokens += usage.totalTokens;
  if (usage.usagePercent > s.peakUsagePercent) {
    s.peakUsagePercent = usage.usagePercent;
  }
}

export function getUsageInfo(phone: string): {
  lastUsage: UsageInfo | null;
  peakUsagePercent: number;
  cumulativeTokens: number;
} {
  const s = getState(phone);
  return {
    lastUsage: s.lastUsage,
    peakUsagePercent: s.peakUsagePercent,
    cumulativeTokens: s.cumulativeTokens,
  };
}

export function shouldRotate(phone: string): RotationReason | null {
  const s = getState(phone);
  const {
    maxConsecutiveErrors,
    maxTaskFailures,
    messageCountForceRotate,
    tokenWarningPercent,
    tokenForceRotatePercent,
  } = config.contextRotation;

  if (s.consecutiveErrors >= maxConsecutiveErrors) return "consecutive_errors";

  for (const count of s.taskFailures.values()) {
    if (count >= maxTaskFailures) return "task_failures";
  }

  // Token-based rotation takes priority over message count
  if (s.lastUsage && s.lastUsage.usagePercent >= tokenForceRotatePercent) {
    return "token_threshold";
  }

  if (s.messageCount >= messageCountForceRotate) return "message_count";

  return null;
}

export function shouldWarnContext(phone: string): boolean {
  const s = getState(phone);
  const { tokenWarningPercent } = config.contextRotation;
  return (
    s.lastUsage !== null &&
    s.lastUsage.usagePercent >= tokenWarningPercent &&
    s.lastUsage.usagePercent < config.contextRotation.tokenForceRotatePercent
  );
}

export function getMessageCount(phone: string): number {
  return getState(phone).messageCount;
}

export async function executeRotation(
  phone: string,
  reason: RotationReason,
): Promise<void> {
  const s = getState(phone);

  const usageSummary = s.lastUsage
    ? `Tokens: ${s.lastUsage.totalTokens.toLocaleString()} / ${s.lastUsage.contextWindow.toLocaleString()} (${s.lastUsage.usagePercent.toFixed(1)}%), Cost: $${s.lastUsage.costUSD.toFixed(4)}`
    : "No usage data";

  await writeHandoff({
    reason: `context rotation: ${reason}`,
    progress: `Messages: ${s.messageCount}, Errors: ${s.consecutiveErrors}, Peak usage: ${s.peakUsagePercent.toFixed(1)}%, Cumulative tokens: ${s.cumulativeTokens.toLocaleString()}. ${usageSummary}`,
  });

  await clearSessionId(phone);

  await appendSystemLog(
    `Context rotation for ${phone}: ${reason} (msgs=${s.messageCount}, errs=${s.consecutiveErrors}, peak=${s.peakUsagePercent.toFixed(1)}%, tokens=${s.cumulativeTokens})`,
  );

  await appendDailyLog(
    "System",
    `[context-rotation] ${reason}`,
    `Session rotated. Messages: ${s.messageCount}, Errors: ${s.consecutiveErrors}, Peak: ${s.peakUsagePercent.toFixed(1)}%, Cumulative: ${s.cumulativeTokens.toLocaleString()}`,
  );

  // Reset counters
  s.consecutiveErrors = 0;
  s.taskFailures.clear();
  s.messageCount = 0;
  s.lastUsage = null;
  s.peakUsagePercent = 0;
  s.cumulativeTokens = 0;
  s.lastRotatedAt = new Date().toISOString();
}
