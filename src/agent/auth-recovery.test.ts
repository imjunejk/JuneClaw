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
  submitCode,
  cancelRelogin,
  _resetForTests,
} from "./auth-recovery.js";

const execFileMock = vi.mocked(execFile);

/** Main-prompt marker required for stage 1 of startRelogin to advance. */
const MAIN_PROMPT_BANNER = "auto mode on (shift+tab to cycle)";

/**
 * Stub every tmux/imsg invocation. capture-pane returns the supplied pane;
 * everything else (new-session, send-keys, kill-session, imsg send) succeeds
 * with empty stdout. Always prepend the main-prompt banner so stage 1 of
 * the state machine matches, mirroring real claude CLI startup.
 */
function stubTmux(captureOutput: string): void {
  const pane = `${MAIN_PROMPT_BANNER}\n${captureOutput}`;
  execFileMock.mockImplementation(((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      err: Error | null,
      value?: { stdout: string; stderr: string },
    ) => void;
    const argv = _args[1] as string[];
    if (argv && argv[0] === "capture-pane") {
      cb(null, { stdout: pane, stderr: "" });
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

    const startPromise = startRelogin(phone);
    // Stage machine has multiple poll windows; advance generously then settle.
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await startPromise;
    expect(result).toContain("🔑");
    expect(isAwaitingCode(phone)).toBe(true);

    // Use a generous margin from "now" — we don't know the exact setState
    // wall-time, but TTL is 5 min so 4 min from now is safely inside and
    // 6 min from now is safely outside.
    const stateBornAt = Date.now();
    vi.setSystemTime(stateBornAt + 4 * 60_000);
    expect(isAwaitingCode(phone)).toBe(true);

    vi.setSystemTime(stateBornAt + 6 * 60_000);
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

    vi.setSystemTime(new Date("2026-05-18T00:29:59Z"));
    await reportAuthFailure();
    expect(execFileMock).toHaveBeenCalledTimes(1);

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
    await vi.advanceTimersByTimeAsync(15_000);
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
      await vi.advanceTimersByTimeAsync(15_000);
      return p;
    })();
    expect(r1).toContain("🔑");

    const r2 = await (async () => {
      const p = startRelogin(phone);
      await vi.advanceTimersByTimeAsync(15_000);
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
    await vi.advanceTimersByTimeAsync(15_000);
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
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await startPromise;
    expect(result).toContain("https://console.anthropic.com");
  });

  test("matches claude.ai URLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Visit https://claude.ai/oauth/authorize?state=abc&code_challenge=xyz",
    );

    const startPromise = startRelogin("+15550002222");
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await startPromise;
    expect(result).toContain("https://claude.ai");
  });

  test("matches claude.com URLs with /cai/oauth/ path (observed in v2.1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux(
      "Browser didn't open? Use the url below to sign in (c to copy)\n" +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz",
    );

    const startPromise = startRelogin("+15550007777");
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await startPromise;
    expect(result).toContain("https://claude.com/cai/oauth/");
  });

  test("extracts URLs even when wrapped across lines (terminal wrap)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    // Simulate terminal wrap: URL broken across two lines with whitespace.
    stubTmux(
      "Sign in URL:\n" +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\n" +
      "ed-5944d1962f5e&response_type=code&redirect_uri=test&scope=user",
    );

    const startPromise = startRelogin("+15550008888");
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await startPromise;
    expect(result).toContain("https://claude.com/cai/oauth/");
    // Reassembled URL should contain content from both wrapped lines.
    expect(result).toContain("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  test("rejects docs URLs that lack /oauth/ segment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    stubTmux("Welcome to Claude. Read docs at https://docs.anthropic.com/help.");

    const startPromise = startRelogin("+15550004444");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await startPromise;
    expect(result).toContain("OAuth URL 추출 실패");
    expect(isAwaitingCode("+15550004444")).toBe(false);
  });

  test("falls back when pane has no recognized URL at all", async () => {
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

describe("submitCode SUCCESS_RE coverage", () => {
  test("recognizes 'Login successful. Press Enter to continue' (real claude v2.1 output)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    const phone = "+15550010101";

    // Pane combines OAuth URL (for startRelogin to extract) + the actual
    // success message that claude CLI prints after accepting the code.
    stubTmux(
      "Visit https://claude.com/cai/oauth/authorize?code=abc\n" +
      "  Logged in as imjunejk@gmail.com\n" +
      "  Login successful. Press Enter to continue…",
    );

    // Drive startRelogin first to set awaiting-code state.
    const startPromise = startRelogin(phone);
    await vi.advanceTimersByTimeAsync(15_000);
    await startPromise;
    expect(isAwaitingCode(phone)).toBe(true);

    // Now submitCode should recognize the success marker in the pane.
    const submitPromise = submitCode(phone, "test-oauth-code-12345");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await submitPromise;
    expect(result).toContain("✅");
    expect(result).toContain("/login 완료");
    expect(isAwaitingCode(phone)).toBe(false);
  });

  test("recognizes 'Logged in as user@host' marker alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    const phone = "+15550010202";

    stubTmux(
      "Visit https://claude.com/cai/oauth/authorize?code=abc\n" +
      "  Logged in as someone@example.org\n",
    );

    const startPromise = startRelogin(phone);
    await vi.advanceTimersByTimeAsync(15_000);
    await startPromise;
    expect(isAwaitingCode(phone)).toBe(true);

    const submitPromise = submitCode(phone, "code");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await submitPromise;
    expect(result).toContain("✅");
  });

  test("submitCode rejects when no /relogin session is active", async () => {
    const result = await submitCode("+15550010303", "some-code");
    expect(result).toContain("진행 중인 /relogin 세션 없음");
  });
});

describe("force-OAuth policy (no 'already logged in' short-circuit)", () => {
  test("main-prompt-only pane triggers /login and waits for OAuth URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));

    // Pane shows only the main prompt — no URL, no wizard. Wizard loop
    // should send /login. Without a URL ever appearing the run times out
    // and returns an error (the user can retry).
    stubTmux("just the main prompt nothing else relevant");

    const phone = "+15550005555";
    const startPromise = startRelogin(phone);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await startPromise;
    expect(result).toContain("OAuth URL 추출 실패");
    expect(isAwaitingCode(phone)).toBe(false);
  });
});
