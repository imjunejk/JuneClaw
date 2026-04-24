import { describe, expect, test } from "vitest";
import { evaluateHeartbeat } from "./heartbeat-gate.js";

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
