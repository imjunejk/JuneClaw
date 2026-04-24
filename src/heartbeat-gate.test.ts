import { describe, expect, test } from "vitest";
import { describePhoneHolder, evaluateHeartbeat } from "./heartbeat-gate.js";

describe("evaluateHeartbeat", () => {
  test("runs when no workers are active", () => {
    const result = evaluateHeartbeat("+12139992143", new Set());
    expect(result.action).toBe("run");
  });

  test("skips when the phone has an active worker", () => {
    const active = new Set(["+12139992143"]);
    const result = evaluateHeartbeat("+12139992143", active);
    expect(result).toEqual({ action: "skip", reason: "worker active for this phone" });
  });

  test("runs when a different phone has an active worker (per-phone isolation)", () => {
    const active = new Set(["+14156938975"]);
    const result = evaluateHeartbeat("+12139992143", active);
    expect(result.action).toBe("run");
  });
});

describe("describePhoneHolder", () => {
  test("returns null when the phone is free", () => {
    expect(describePhoneHolder("+12139992143", new Set(), new Set())).toBeNull();
  });

  test("returns 'worker' when worker holds but heartbeat does not", () => {
    const workers = new Set(["+12139992143"]);
    expect(describePhoneHolder("+12139992143", workers, new Set())).toBe("worker");
  });

  test("returns 'heartbeat' when both sets contain the phone", () => {
    const workers = new Set(["+12139992143"]);
    const heartbeats = new Set(["+12139992143"]);
    expect(describePhoneHolder("+12139992143", workers, heartbeats)).toBe("heartbeat");
  });

  test("heartbeat-only (inconsistent state) still reports null — workers is the source of truth", () => {
    // Shouldn't happen in practice (runHeartbeat mutates both in lockstep),
    // but if activeHeartbeats somehow leaks without activeWorkers, the drain
    // doesn't defer — matches `if (activePhones.has(phone))` gate in daemon.
    const heartbeats = new Set(["+12139992143"]);
    expect(describePhoneHolder("+12139992143", new Set(), heartbeats)).toBeNull();
  });
});
