import { config } from "../config.js";

export interface DailyCost {
  date: string; // YYYY-MM-DD
  totalUSD: number;
  callCount: number;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0]!;
}

let current: DailyCost = {
  date: todayStr(),
  totalUSD: 0,
  callCount: 0,
};

/** Reset tracking if the day has rolled over. */
function ensureCurrentDay(): void {
  const today = todayStr();
  if (current.date !== today) {
    current = { date: today, totalUSD: 0, callCount: 0 };
  }
}

/** Record a cost from a single API call. */
export function recordCost(costUSD: number): void {
  ensureCurrentDay();
  current.totalUSD += costUSD;
  current.callCount++;
}

/** Get the current day's cost stats. */
export function getDailyCost(): DailyCost {
  ensureCurrentDay();
  return { ...current };
}

/** Check if the daily cost limit has been exceeded. dailyLimitUSD <= 0 이면 비활성화. */
export function isOverLimit(): boolean {
  ensureCurrentDay();
  const limit = config.costMonitor.dailyLimitUSD;
  if (limit <= 0) return false;
  return current.totalUSD >= limit;
}

/** Check if we are at or above the warning threshold (default 80%). dailyLimitUSD <= 0 이면 비활성화. */
export function isNearLimit(): boolean {
  ensureCurrentDay();
  const limit = config.costMonitor.dailyLimitUSD;
  if (limit <= 0) return false;
  const threshold = limit * (config.costMonitor.warningPercent / 100);
  return current.totalUSD >= threshold;
}
