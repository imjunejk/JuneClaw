/**
 * Decide whether a HEARTBEAT invocation should run or skip.
 *
 * Context (R-E08): HEARTBEAT is a periodic cron that invokes claude on a
 * phone-scoped channel. If a worker is already processing a user message on
 * the same phone, HEARTBEAT must skip — otherwise two claude instances race
 * on shared session state and may re-execute the same user request. This
 * happened on 2026-04-24 and produced a duplicate MU x3 trade order.
 *
 * See memory/INCIDENT.md — 2026-04-24 HEARTBEAT-triggered duplicate trade.
 */
export type HeartbeatDecision =
  | { action: "skip"; reason: string }
  | { action: "run" };

export function evaluateHeartbeat(
  phone: string,
  activeWorkers: ReadonlySet<string>,
): HeartbeatDecision {
  if (activeWorkers.has(phone)) {
    return { action: "skip", reason: "worker active for this phone" };
  }
  return { action: "run" };
}

/**
 * Identify which component currently holds a phone's worker slot, for the
 * queue drain's deferral log. Returns null if the phone is free.
 *
 * `activeHeartbeats` is a subset of `activeWorkers`: runHeartbeat adds to
 * both, the worker pool only adds to `activeWorkers`. When the phone is
 * busy, the heartbeat set disambiguates so operators can tell why a user
 * message is being delayed.
 */
export function describePhoneHolder(
  phone: string,
  activeWorkers: ReadonlySet<string>,
  activeHeartbeats: ReadonlySet<string>,
): "heartbeat" | "worker" | null {
  if (!activeWorkers.has(phone)) return null;
  return activeHeartbeats.has(phone) ? "heartbeat" : "worker";
}
