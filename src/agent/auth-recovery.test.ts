import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock execFile before importing the module under test — module-level
// promisify(execFile) captures the reference at import time.
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile };
});

import { execFile } from "node:child_process";
import {
  isAwaitingCode,
  reportAuthFailure,
  startRelogin,
  cancelRelogin,
  _resetForTests,
} from "./auth-recovery.js";

const execFileMock = vi.mocked(execFile);

/**
 * Make execFile (callback API used by promisify) succeed with a given pane
 * dump. Stubs every tmux invocation in the recovery flow.
 */
function stubTmux(captureOutput: string): void {
  execFileMock.mockImplementation(((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      err: Error | null,
      value?: { stdout: string; stderr: string },
    ) => void;
    const argv = _args[1] as string[];
    if (argv && argv[0] === "capture-pane") {
      cb(null, { stdout: captureOutput, stderr: "" });
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

beforeEach(() => {
  _resetForTests();
  execFileMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isAwaitingCode TTL", () => {
  test("returns true while within 5-min window, false after expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    const phone = "+15550001111";
    stubTmux(
      "Visit https://console.anthropic.com/oauth/authorize?code=abc to continue",
    );

    // startRelogin internally polls — fast-forward across each sleep so the
    // promise chain resolves without real-time waits.
    const startPromise = startRelogin(phone);
    // startRelogin internally awaits ~4.5s (2500ms claude start + 2000ms URL
    // poll). Advance just enough to let it complete — overshooting moves the
    // fake clock past setState's call site and confuses TTL math.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await startPromise;
    expect(result).toContain("🔑");
    expect(isAwaitingCode(phone)).toBe(true);

    // Anchor TTL math to whenever setState ran (post-URL-extraction).
    const stateBornAt = Date.now();

    // 4:59 after state birth → still awaiting.
    vi.setSystemTime(stateBornAt + 4 * 60_000 + 59_000);
    expect(isAwaitingCode(phone)).toBe(true);

    // 5:01 → expired.
    vi.setSystemTime(stateBornAt + 5 * 60_000 + 1000);
    expect(isAwaitingCode(phone)).toBe(false);
  });

  test("isAwaitingCode is false when no /relogin has been called", () => {
    expect(isAwaitingCode("+15550009999")).toBe(false);
  });
});

describe("reportAuthFailure dedup", () => {
  test("first call sends imsg; second call within 30min is suppressed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    execFileMock.mockImplementation(((..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as (
        err: Error | null,
        value?: { stdout: string; stderr: string },
      ) => void;
      cb(null, { stdout: "", stderr: "" });
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    await reportAuthFailure();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const firstArgv = execFileMock.mock.calls[0][1] as string[];
    expect(firstArgv[0]).toBe("send");
    expect(firstArgv).toContain("--to");

    // Second call within window → no new imsg.
    vi.setSystemTime(new Date("2026-05-18T00:29:59Z"));
    await reportAuthFailure();
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // After window → fires again.
    vi.setSystemTime(new Date("2026-05-18T00:30:01Z"));
    await reportAuthFailure();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("concurrent /relogin protection", () => {
  test("second phone is rejected while another phone is mid-recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Visit https://console.anthropic.com/oauth/authorize?code=abc",
    );

    const a = "+15550001111";
    const b = "+15550002222";

    const startA = startRelogin(a);
    await vi.advanceTimersByTimeAsync(60_000);
    const resultA = await startA;
    expect(resultA).toContain("🔑");
    expect(isAwaitingCode(a)).toBe(true);

    const resultB = await startRelogin(b);
    expect(resultB).toContain("다른 사용자");
    expect(isAwaitingCode(b)).toBe(false);
  });

  test("same phone can re-initiate without lockout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Visit https://console.anthropic.com/oauth/authorize?code=abc",
    );

    const phone = "+15550001111";
    const r1 = await (async () => {
      const p = startRelogin(phone);
      await vi.advanceTimersByTimeAsync(5000);
      return p;
    })();
    expect(r1).toContain("🔑");

    const r2 = await (async () => {
      const p = startRelogin(phone);
      await vi.advanceTimersByTimeAsync(5000);
      return p;
    })();
    expect(r2).toContain("🔑");
  });
});

describe("cancelRelogin idempotency", () => {
  test("returns 'no session' when no /relogin is active", async () => {
    const result = await cancelRelogin("+15550001111");
    expect(result).toContain("없음");
  });

  test("clears state when an active session exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Visit https://console.anthropic.com/oauth/authorize?code=abc",
    );

    const phone = "+15550001111";
    const startPromise = startRelogin(phone);
    await vi.advanceTimersByTimeAsync(60_000);
    await startPromise;
    expect(isAwaitingCode(phone)).toBe(true);

    const result = await cancelRelogin(phone);
    expect(result).toContain("취소됨");
    expect(isAwaitingCode(phone)).toBe(false);
  });
});

describe("URL_RE coverage", () => {
  test("matches console.anthropic.com URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Open this URL: https://console.anthropic.com/oauth/authorize?code=xyz123",
    );

    const startPromise = startRelogin("+15550001111");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await startPromise;
    expect(result).toContain("https://console.anthropic.com");
  });

  test("matches claude.ai URLs (OAuth might redirect via claude.ai)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Visit https://claude.ai/oauth/authorize?state=abc&code_challenge=xyz",
    );

    const startPromise = startRelogin("+15550002222");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await startPromise;
    expect(result).toContain("https://claude.ai");
  });

  test("falls back to error message when no recognized URL is in the pane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux("Some unrelated terminal output without any OAuth URL.");

    const startPromise = startRelogin("+15550003333");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await startPromise;
    expect(result).toContain("URL 추출 실패");
    expect(isAwaitingCode("+15550003333")).toBe(false);
  });
});
