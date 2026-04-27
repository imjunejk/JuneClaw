import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startBridge, updateBridgeContext, verifySignupSignature } from "./server.js";

const SIGNUP_SECRET = "test-signup-secret-do-not-use";  // test-setup.ts 와 동일

function signupSig(rawBody: string): string {
  return createHmac("sha256", SIGNUP_SECRET).update(rawBody).digest("hex");
}

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

  describe("POST /webhook/signup-request", () => {
    test("valid signature → 200 + sendToPhone called with formatted text", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        display: "213-999-2143",
        name: "준",
        requested_at: "2026-04-26T20:00:00.000Z",
        ip: "1.2.3.4",
      });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });  // PII echo 제거 (Minor #4)
      expect(ctx.sendToPhone).toHaveBeenCalledTimes(1);
      const [phone, text] = ctx.sendToPhone.mock.calls[0];
      expect(typeof phone).toBe("string");
      expect(text).toContain("🆕 갈레온 가입 요청");
      expect(text).toContain("📱 Phone: 213-999-2143");
      expect(text).toContain("이름: 준");
      expect(text).toContain("IP: 1.2.3.4");
    });

    test("email kind → ✉️ Email prefix", async () => {
      const body = JSON.stringify({ identifier: "user@example.com", kind: "email", display: "user@example.com" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(200);
      const text = ctx.sendToPhone.mock.calls[0][1] as string;
      expect(text).toContain("✉️ Email: user@example.com");
    });

    test("invalid signature → 401, no send", async () => {
      const body = JSON.stringify({ identifier: "+12139992143", display: "213-999-2143" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": "0".repeat(64) },
        body,
      });
      expect(res.status).toBe(401);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("missing x-signature header → 401", async () => {
      const body = JSON.stringify({ identifier: "+12139992143", display: "213-999-2143" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(401);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("length-mismatched signature → 401 (timing-safe-equal pre-pass)", async () => {
      const body = JSON.stringify({ identifier: "+12139992143", display: "213-999-2143" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": "abc" },
        body,
      });
      expect(res.status).toBe(401);
    });

    test("missing display/identifier → 400", async () => {
      const body = JSON.stringify({ kind: "phone" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(400);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("invalid JSON → 400", async () => {
      const body = "not json {{";
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(400);
    });

    test("requested_at over 40 chars truncated", async () => {
      const longTs = "2026-04-26T20:00:00.000Z" + "X".repeat(50);
      const body = JSON.stringify({
        identifier: "+12139992143", display: "213-999-2143", requested_at: longTs,
      });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(200);
      const text = ctx.sendToPhone.mock.calls[0][1] as string;
      const reqLine = text.split("\n").find((l) => l.startsWith("요청:")) ?? "";
      // "요청: " + 40 chars
      expect(reqLine.length).toBeLessThanOrEqual("요청: ".length + 40);
    });

    test("kind 가 'email' 아니면 모두 Phone fallback", async () => {
      // empty / undefined / 잘못된 값 → 📱 Phone
      const body = JSON.stringify({ identifier: "+12139992143", display: "213-999-2143", kind: "garbage" });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(200);
      const text = ctx.sendToPhone.mock.calls[0][1] as string;
      expect(text).toContain("📱 Phone");
      expect(text).not.toContain("✉️ Email");
    });

    test("body too large → 413", async () => {
      // 1MB 초과
      const big = "x".repeat(1_000_001);
      const body = JSON.stringify({ identifier: "+12139992143", display: "213-999-2143", padding: big });
      const res = await fetch(`${BASE}/webhook/signup-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": signupSig(body) },
        body,
      });
      expect(res.status).toBe(413);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });
  });

  describe("verifySignupSignature (pure helper)", () => {
    test("valid signature → true", () => {
      const body = '{"x":1}';
      expect(verifySignupSignature(body, signupSig(body), SIGNUP_SECRET)).toBe(true);
    });

    test("wrong signature → false", () => {
      expect(verifySignupSignature('{"x":1}', "0".repeat(64), SIGNUP_SECRET)).toBe(false);
    });

    test("array header (rare proxy bug) → false", () => {
      const body = '{"x":1}';
      expect(verifySignupSignature(body, [signupSig(body), signupSig(body)], SIGNUP_SECRET)).toBe(false);
    });

    test("undefined header → false", () => {
      expect(verifySignupSignature('{"x":1}', undefined, SIGNUP_SECRET)).toBe(false);
    });

    test("empty secret → false", () => {
      expect(verifySignupSignature('{"x":1}', signupSig('{"x":1}'), "")).toBe(false);
    });

    test("malformed hex → false (early reject)", () => {
      // Hex 가 아닌 char 포함, 길이만 맞춤 (64 char)
      const malformed = "Z".repeat(64);
      expect(verifySignupSignature('{"x":1}', malformed, SIGNUP_SECRET)).toBe(false);
    });
  });
});
