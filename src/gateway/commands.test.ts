import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock execFile before importing commands (module-level async binding captures reference).
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile };
});

import { execFile } from "node:child_process";
import { handleCommand } from "./commands.js";

const execFileMock = vi.mocked(execFile);

// Minimal child object shape the helpers need (unref method).
type MockChild = { unref: () => void };

// Fire-and-forget stub (sepa-confirm) — callback 호출 안 함 (process detached).
function mockFireAndForget(): MockChild {
  const child: MockChild = { unref: () => {} };
  execFileMock.mockImplementation(((..._args: unknown[]) => child) as unknown as typeof execFile);
  return child;
}

// Async exec stub (sepa-reject) — promisify(execFile) wrapper 는 custom symbol
// 없을 시 (err, value) 2-arg 만 읽음. execFile 의 실제 동작 재현 위해
// callback 에 { stdout, stderr } 객체 전달.
function mockExecAsync(stdout: string, ok = true) {
  execFileMock.mockImplementation(((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (err: Error | null, value?: { stdout: string; stderr: string }) => void;
    if (ok) cb(null, { stdout, stderr: "" });
    else cb(new Error(stdout));
    return { unref: () => {} } as MockChild as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

// Back-compat: 기존 setupExecFileAsync 이름 (단순 래퍼).
function setupExecFileAsync(stdout: string, ok = true) {
  mockExecAsync(stdout, ok);
}

describe("handleCommand SEPA natural language triggers", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test("'매매해' triggers sepa-confirm (fire-and-forget)", async () => {
    let captured: { cmd?: string; args?: string[] } = {};
    execFileMock.mockImplementation(((cmd: string, args: string[], _opts: unknown, _cb: unknown) => {
      captured = { cmd, args };
      return { unref: () => {} } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const result = await handleCommand("매매해", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("실행 시작");
    expect(captured.cmd).toContain("python");
    expect(captured.args).toContain("sepa-confirm");
  });

  test("'매매해줘' also triggers sepa-confirm", async () => {
    mockFireAndForget();
    const result = await handleCommand("매매해줘", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("실행 시작");
  });

  test("'execute' triggers sepa-confirm (case-insensitive)", async () => {
    mockFireAndForget();
    const result = await handleCommand("EXECUTE", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("'실행해줘' triggers sepa-confirm", async () => {
    mockFireAndForget();
    const result = await handleCommand("실행해줘", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("'실행' alone does NOT trigger (M1 — too ambiguous)", async () => {
    mockFireAndForget();
    const result = await handleCommand("실행", "+14155550100");
    // "실행" 단독은 confirm trigger 아님 (script/cron 맥락에서 오탐 방지)
    expect(result.handled).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("'취소' triggers sepa-reject", async () => {
    mockExecAsync("🛑 plan 취소됨");
    const result = await handleCommand("취소", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소");
  });

  test("'cancel' triggers sepa-reject (case-insensitive)", async () => {
    mockExecAsync("🛑 plan 취소됨");
    const result = await handleCommand("CANCEL", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("conversational text does NOT trigger (false-positive safety)", async () => {
    mockFireAndForget();
    for (const text of [
      "NVDA 매매해줘 내일",
      "너 execute 알아?",
      "AAPL 실행 관련 질문",
      "이거 취소할 수 있어?",
    ]) {
      const result = await handleCommand(text, "+14155550100");
      expect(result.handled).toBe(false);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("trim + lowercase before match", async () => {
    mockFireAndForget();
    const result = await handleCommand("  매매해  ", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("empty input is unhandled", async () => {
    mockFireAndForget();
    for (const text of ["", "   ", "\t\n"]) {
      const result = await handleCommand(text, "+14155550100");
      expect(result.handled).toBe(false);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("sepa-reject with empty stdout uses default message", async () => {
    mockExecAsync("");  // Python 이 아무것도 출력 안 한 경우
    const result = await handleCommand("취소", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소됨");
  });

  test("sepa-reject error propagates", async () => {
    mockExecAsync("python crashed", false);
    const result = await handleCommand("취소", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소 실패");
  });
});

describe("handleCommand /sepa-* slash commands", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test("/sepa-confirm slash command works", async () => {
    mockFireAndForget();
    const result = await handleCommand("/sepa-confirm", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("실행 시작");
  });

  test("/sepa-reject slash command works", async () => {
    mockExecAsync("🛑 plan 취소됨");
    const result = await handleCommand("/sepa-reject", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소");
  });

  test("/sepa-confirm with extra args still executes (args ignored)", async () => {
    // Slash 명령이 인자 받아도 sepa-confirm 은 인자 무시하고 그냥 실행
    let capturedArgs: string[] = [];
    execFileMock.mockImplementation(((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return { unref: () => {} } as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
    const result = await handleCommand("/sepa-confirm extra-noise", "+14155550100");
    expect(result.handled).toBe(true);
    // Python args 에 "extra-noise" 없어야 함 — 인자 무시
    expect(capturedArgs).toContain("sepa-confirm");
    expect(capturedArgs).not.toContain("extra-noise");
  });
});
