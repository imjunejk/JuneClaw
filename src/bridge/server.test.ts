import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startBridge, updateBridgeContext } from "./server.js";

const PORT = Number(process.env.JUNECLAW_BRIDGE_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

interface MockContext {
  sendMessage: ReturnType<typeof vi.fn>;
  sendToPhone: ReturnType<typeof vi.fn>;
  enqueueMessage: ReturnType<typeof vi.fn>;
  getChannels: ReturnType<typeof vi.fn>;
}

function buildContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendToPhone: vi.fn().mockResolvedValue(undefined),
    enqueueMessage: vi.fn().mockResolvedValue("msg_123"),
    getChannels: vi.fn().mockReturnValue([
      { name: "june", phone: "+14155550100", chatId: 1, accessLevel: "full" },
    ]),
    ...overrides,
  };
}

function waitForListen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

describe("bridge HTTP server", () => {
  let server: Server;
  let ctx: MockContext;

  beforeEach(async () => {
    ctx = buildContext();
    server = startBridge(ctx);
    await waitForListen(server);
    // Silence the listener log
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  describe("GET /bridge/health", () => {
    test("returns 200 with status ok", async () => {
      const res = await fetch(`${BASE}/bridge/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(typeof body.pid).toBe("number");
      expect(typeof body.uptime).toBe("number");
    });

    test("does not expose CORS wildcard", async () => {
      const res = await fetch(`${BASE}/bridge/health`);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("GET /bridge/channels", () => {
    test("returns channel list from context", async () => {
      const res = await fetch(`${BASE}/bridge/channels`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([
        { name: "june", phone: "+14155550100", chatId: 1, accessLevel: "full" },
      ]);
      expect(ctx.getChannels).toHaveBeenCalledOnce();
    });

    test("returns 503 when context not wired", async () => {
      updateBridgeContext({ getChannels: undefined });
      const res = await fetch(`${BASE}/bridge/channels`);
      expect(res.status).toBe(503);
      // restore for subsequent tests
      updateBridgeContext({ getChannels: ctx.getChannels });
    });
  });

  describe("POST /bridge/message", () => {
    test("sends message via context on happy path", async () => {
      const res = await fetch(`${BASE}/bridge/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "june", text: "hello" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, channel: "june", length: 5 });
      expect(ctx.sendMessage).toHaveBeenCalledWith("june", "hello");
    });

    test("returns 400 on missing fields", async () => {
      const res = await fetch(`${BASE}/bridge/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "june" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Missing/);
    });

    test("returns 400 on malformed JSON", async () => {
      const res = await fetch(`${BASE}/bridge/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not valid",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid JSON/);
    });

    test("returns 413 on oversized body", async () => {
      const oversized = "x".repeat(1_000_001);
      const res = await fetch(`${BASE}/bridge/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "june", text: oversized }),
      });
      expect(res.status).toBe(413);
    });

    test("returns 500 and preserves error message when handler throws", async () => {
      ctx.sendMessage.mockRejectedValueOnce(new Error("channel unavailable"));
      const res = await fetch(`${BASE}/bridge/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "june", text: "hi" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("channel unavailable");
    });
  });

  describe("POST /bridge/send-to-phone", () => {
    test("masks phone in response body", async () => {
      const res = await fetch(`${BASE}/bridge/send-to-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+14155550100", text: "hi" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.phone).toBe("+141***0100");
      expect(body.phone).not.toContain("55550");
    });
  });

  describe("POST /bridge/enqueue", () => {
    test("returns the enqueued id", async () => {
      const res = await fetch(`${BASE}/bridge/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "june", text: "hi", taskType: "heavy" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, id: "msg_123" });
      expect(ctx.enqueueMessage).toHaveBeenCalledWith("june", "hi", "heavy");
    });
  });

  describe("routing", () => {
    test("returns 404 for unknown routes", async () => {
      const res = await fetch(`${BASE}/bridge/does-not-exist`);
      expect(res.status).toBe(404);
    });

    test("returns 404 for wrong method on known path", async () => {
      const res = await fetch(`${BASE}/bridge/health`, { method: "POST" });
      expect(res.status).toBe(404);
    });
  });
});
