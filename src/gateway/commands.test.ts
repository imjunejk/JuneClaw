import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock execFile before importing commands (module-level async binding captures reference).
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile };
});

import { execFile } from "node:child_process";
import { handleCommand } from "./commands.js";

const execFileMock = vi.mocked(execFile);

function setupExecFileAsync(stdout: string, ok = true) {
  // promisify(execFile) reads execFile's signature and calls callback(err, stdout, stderr).
  execFileMock.mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: (
    err: Error | null,
    stdout: string,
    stderr: string,
  ) => void) => {
    if (ok) cb(null, stdout, "");
    else cb(new Error(stdout), "", stdout);
    return { unref: () => {} } as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

describe("handleCommand SEPA natural language triggers", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test("'매매해' triggers sepa-confirm (fire-and-forget)", async () => {
    // Fire-and-forget: execFile called w/ callback but parent doesn't wait.
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
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    const result = await handleCommand("매매해줘", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("실행 시작");
  });

  test("'execute' triggers sepa-confirm (case-insensitive)", async () => {
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    const result = await handleCommand("EXECUTE", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("'실행해줘' triggers sepa-confirm", async () => {
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    const result = await handleCommand("실행해줘", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("'취소' triggers sepa-reject", async () => {
    setupExecFileAsync("🛑 plan 취소됨");
    const result = await handleCommand("취소", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소");
  });

  test("'cancel' triggers sepa-reject (case-insensitive)", async () => {
    setupExecFileAsync("🛑 plan 취소됨");
    const result = await handleCommand("CANCEL", "+14155550100");
    expect(result.handled).toBe(true);
  });

  test("conversational text does NOT trigger (false-positive safety)", async () => {
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    for (const text of [
      "NVDA 매매해줘 내일",  // 자연 대화, 정확한 exact match 아님
      "너 execute 알아?",
      "AAPL 실행 관련 질문",
      "이거 취소할 수 있어?",  // "취소" 포함하지만 exact match 아님
    ]) {
      const result = await handleCommand(text, "+14155550100");
      expect(result.handled).toBe(false);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("trim + lowercase before match", async () => {
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    const result = await handleCommand("  매매해  ", "+14155550100");
    expect(result.handled).toBe(true);
  });
});

describe("handleCommand /sepa-* slash commands", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  test("/sepa-confirm slash command works", async () => {
    execFileMock.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof execFile);
    const result = await handleCommand("/sepa-confirm", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("실행 시작");
  });

  test("/sepa-reject slash command works", async () => {
    setupExecFileAsync("🛑 plan 취소됨");
    const result = await handleCommand("/sepa-reject", "+14155550100");
    expect(result.handled).toBe(true);
    expect(result.response).toContain("취소");
  });
});
