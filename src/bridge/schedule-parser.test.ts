import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { forwardSchedules, parseScheduleBlocks, stripScheduleBlocks } from "./schedule-parser.js";

function block(opts: { phone?: string; at?: string; message?: string } = {}): string {
  return [
    "[[SCHEDULE",
    `phone: ${opts.phone ?? "+14155550100"}`,
    `at: ${opts.at ?? "2026-12-25T09:00:00-08:00"}`,
    `message: ${opts.message ?? "merry christmas"}`,
    "]]",
  ].join("\n");
}

describe("parseScheduleBlocks", () => {
  test("extracts a single well-formed block", () => {
    const result = parseScheduleBlocks(`Hi!\n${block()}\nBye.`);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      phone: "+14155550100",
      fireAt: "2026-12-25T17:00:00.000Z", // normalized to UTC
      message: "merry christmas",
    });
  });

  test("extracts multiple blocks from one response", () => {
    const text = [
      block({ phone: "+14155550100", message: "first" }),
      "some text between",
      block({ phone: "+14155550200", message: "second" }),
    ].join("\n");
    const result = parseScheduleBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("first");
    expect(result[1].message).toBe("second");
  });

  test("strips formatting chars from phone (dashes, parens, spaces)", () => {
    const result = parseScheduleBlocks(block({ phone: "+1 (415) 555-0100" }));
    expect(result[0].phone).toBe("+14155550100");
  });

  test("accepts phone without leading +", () => {
    const result = parseScheduleBlocks(block({ phone: "14155550100" }));
    expect(result[0].phone).toBe("14155550100");
  });

  test("normalizes various ISO-8601 inputs to UTC", () => {
    const cases: Array<[string, string]> = [
      ["2026-12-25T09:00:00-08:00", "2026-12-25T17:00:00.000Z"],
      ["2026-12-25T17:00:00Z", "2026-12-25T17:00:00.000Z"],
      ["2026-12-25T17:00:00+00:00", "2026-12-25T17:00:00.000Z"],
    ];
    for (const [input, expected] of cases) {
      const result = parseScheduleBlocks(block({ at: input }));
      expect(result[0]?.fireAt, `input=${input}`).toBe(expected);
    }
  });

  describe("rejects invalid blocks", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    test("missing phone field", () => {
      const text = "[[SCHEDULE\nat: 2026-12-25T09:00:00Z\nmessage: hi\n]]";
      expect(parseScheduleBlocks(text)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing 'phone'"));
    });

    test("invalid phone format (too short)", () => {
      expect(parseScheduleBlocks(block({ phone: "12345" }))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid phone format"));
    });

    test("invalid phone format (letters)", () => {
      expect(parseScheduleBlocks(block({ phone: "call-me" }))).toEqual([]);
    });

    test("invalid ISO-8601 at", () => {
      expect(parseScheduleBlocks(block({ at: "tomorrow at noon" }))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid ISO-8601"));
    });

    test("message exceeds length cap", () => {
      const huge = "x".repeat(1_001);
      expect(parseScheduleBlocks(block({ message: huge }))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("message exceeds 1000 chars"));
    });

    test("accepts message at exactly the cap", () => {
      const atCap = "x".repeat(1_000);
      const result = parseScheduleBlocks(block({ message: atCap }));
      expect(result).toHaveLength(1);
      expect(result[0].message).toHaveLength(1_000);
    });
  });

  test("handles multi-line message values", () => {
    const text = `[[SCHEDULE
phone: +14155550100
at: 2026-12-25T09:00:00Z
message: line one
line two
line three
]]`;
    const result = parseScheduleBlocks(text);
    expect(result[0].message).toBe("line one\nline two\nline three");
  });

  test("returns empty array when text has no SCHEDULE blocks", () => {
    expect(parseScheduleBlocks("just a regular response")).toEqual([]);
  });

  test("tolerates trailing whitespace before closing ]]", () => {
    const text = "[[SCHEDULE\nphone: +14155550100\nat: 2026-12-25T09:00:00Z\nmessage: hi  \n  ]]";
    expect(parseScheduleBlocks(text)).toHaveLength(1);
  });
});

describe("stripScheduleBlocks", () => {
  test("removes block from surrounding text", () => {
    const text = `Hi!\n\n${block()}\n\nBye.`;
    expect(stripScheduleBlocks(text)).toBe("Hi!\n\nBye.");
  });

  test("collapses 3+ consecutive newlines to 2", () => {
    const text = `A\n${block()}\nB`;
    expect(stripScheduleBlocks(text)).not.toMatch(/\n{3}/);
  });

  test("leaves text without blocks untouched", () => {
    expect(stripScheduleBlocks("plain text")).toBe("plain text");
  });
});

describe("forwardSchedules", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("no-ops on empty input", async () => {
    const result = await forwardSchedules([]);
    expect(result).toEqual({ ok: 0, failed: 0, failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("posts each block to Hustle with expected payload", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "r_1" }), { status: 200 }));
    const blocks = [
      { phone: "+14155550100", fireAt: "2026-12-25T17:00:00.000Z", message: "hi" },
      { phone: "+14155550200", fireAt: "2026-12-26T17:00:00.000Z", message: "bye" },
    ];

    const result = await forwardSchedules(blocks);

    expect(result.ok).toBe(2);
    expect(result.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall[0]).toBe("http://127.0.0.1:3199/api/internal/reminders");
    const body = JSON.parse(firstCall[1].body);
    expect(body).toMatchObject({
      teamId: "test-team-id",
      phone: "+14155550100",
      message: "hi",
      fireAt: "2026-12-25T17:00:00.000Z",
      source: "agent",
    });
    expect(firstCall[1].headers["X-Internal-Key"]).toBe("test-key");
  });

  test("records per-block failures with HTTP status", async () => {
    fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
    const result = await forwardSchedules([
      { phone: "+14155550100", fireAt: "2026-12-25T17:00:00.000Z", message: "hi" },
    ]);
    expect(result.failed).toBe(1);
    expect(result.failures[0].reason).toContain("HTTP 400");
  });

  test("records network errors as failures", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await forwardSchedules([
      { phone: "+14155550100", fireAt: "2026-12-25T17:00:00.000Z", message: "hi" },
    ]);
    expect(result.failed).toBe(1);
    expect(result.failures[0].reason).toBe("ECONNREFUSED");
  });

  test("reports timeout when fetch aborts", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const result = await forwardSchedules([
      { phone: "+14155550100", fireAt: "2026-12-25T17:00:00.000Z", message: "hi" },
    ]);
    expect(result.failures[0].reason).toMatch(/timeout after \d+ms/);
  });

  test("partial success: mixed ok + failed", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const result = await forwardSchedules([
      { phone: "+14155550100", fireAt: "2026-12-25T17:00:00.000Z", message: "a" },
      { phone: "+14155550200", fireAt: "2026-12-26T17:00:00.000Z", message: "b" },
    ]);
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].phone).toBe("+14155550200");
  });
});
