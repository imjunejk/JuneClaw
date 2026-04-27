import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  startBridge,
  updateBridgeContext,
  verifyHmacSignature,
  verifyTimestampedHmacSignature,
} from "./server.js";

const SIGNUP_SECRET = "test-signup-secret-do-not-use";  // test-setup.ts 와 동일
const MAGIC_SECRET = "test-magic-link-secret-do-not-use";

function signupSig(rawBody: string): string {
  return createHmac("sha256", SIGNUP_SECRET).update(rawBody).digest("hex");
}

/** Magic webhook 의 timestamped HMAC: hex(HMAC(`${ts}\n${body}`)). */
function magicSig(rawBody: string, tsSec?: number): { sig: string; ts: string } {
  const ts = String(tsSec ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", MAGIC_SECRET).update(`${ts}\n${rawBody}`).digest("hex");
  return { sig, ts };
}

/** Magic webhook 의 표준 헤더 빌드 — 모든 테스트 helper.
 *  Connection: close — undici keep-alive 가 server.close 사이클과 충돌해 CI 에서
 *  간헐적 SocketError 를 일으킴. 명시적으로 비활성화. */
function magicHeaders(rawBody: string, tsSec?: number): Record<string, string> {
  const { sig, ts } = magicSig(rawBody, tsSec);
  return {
    "Content-Type": "application/json",
    "Connection": "close",
    "x-signature": sig,
    "x-timestamp": ts,
  };
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

  describe("POST /webhook/magic-link-send", () => {
    const magicLink = "https://galleon.market/auth/verify#tk=eyJfake";

    test("valid → 200 + sendToPhone called with link in text", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        display: "213-999-2143",
        magic_link: magicLink,
        ttl_min: 10,
        requested_at: "2026-04-27T01:00:00.000Z",
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(ctx.sendToPhone).toHaveBeenCalledTimes(1);
      const [phone, text] = ctx.sendToPhone.mock.calls[0];
      expect(phone).toBe("+12139992143");
      expect(text).toContain("🔐 갈레온 로그인 링크");
      expect(text).toContain(magicLink);
      expect(text).toContain("10분 안에 탭");
    });

    test("email kind → ✉️ prefix, sendToPhone with email", async () => {
      const body = JSON.stringify({
        identifier: "user@example.com",
        kind: "email",
        display: "user@example.com",
        magic_link: magicLink,
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(200);
      const [phone, text] = ctx.sendToPhone.mock.calls[0];
      expect(phone).toBe("user@example.com");
      expect(text).toContain("✉️ user@example.com");
    });

    test("invalid signature → 401, no send", async () => {
      const body = JSON.stringify({ identifier: "+12139992143", magic_link: magicLink });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature": "0".repeat(64),
          "x-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body,
      });
      expect(res.status).toBe(401);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("missing identifier → 400", async () => {
      const body = JSON.stringify({ kind: "phone", magic_link: magicLink });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
    });

    test("missing magic_link → 400", async () => {
      const body = JSON.stringify({ identifier: "+12139992143", kind: "phone" });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
    });

    test("non-https magic_link → 400 (anti-spoof)", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: "http://attacker.example.com/phish",
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("https but disallowed host → 400 (host allowlist)", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: "https://attacker.example.com/auth/verify#tk=fake",
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("CF Pages preview subdomain → 200 (allowlist endsWith)", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: "https://abc123.galleon-market.pages.dev/auth/verify#tk=fake",
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(200);
    });

    test("malformed phone identifier → 400", async () => {
      const body = JSON.stringify({
        identifier: "not-a-phone",
        kind: "phone",
        magic_link: magicLink,
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("malformed email identifier → 400", async () => {
      const body = JSON.stringify({
        identifier: "no-at-sign",
        kind: "email",
        magic_link: magicLink,
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
    });

    test("unknown kind → 400 (kind whitelist)", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "fax",
        magic_link: magicLink,
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(400);
    });

    test("ttl_min out of range → 400", async () => {
      // 0, 음수, 거대값, NaN 모두 거절
      for (const ttl of [0, -1, 999, "abc"]) {
        const body = JSON.stringify({
          identifier: "+12139992143",
          kind: "phone",
          magic_link: magicLink,
          ttl_min: ttl,
        });
        const res = await fetch(`${BASE}/webhook/magic-link-send`, {
          method: "POST",
          headers: magicHeaders(body),
          body,
        });
        expect(res.status, `ttl_min=${ttl}`).toBe(400);
      }
    });

    test("stale timestamp (>5min old) → 401", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: magicLink,
      });
      const staleTs = Math.floor(Date.now() / 1000) - 600;  // 10분 전
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body, staleTs),
        body,
      });
      expect(res.status).toBe(401);
      expect(ctx.sendToPhone).not.toHaveBeenCalled();
    });

    test("future timestamp (>1min ahead) → 401", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: magicLink,
      });
      const futureTs = Math.floor(Date.now() / 1000) + 600;  // 10분 후
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body, futureTs),
        body,
      });
      expect(res.status).toBe(401);
    });

    test("missing x-timestamp → 401", async () => {
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: magicLink,
      });
      const { sig } = magicSig(body);
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature": sig,
          // x-timestamp 일부러 누락
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    test("uses MAGIC_LINK_WEBHOOK_SECRET (not SIGNUP)", async () => {
      // signup secret 으로 서명한 요청은 거절돼야 함 (다른 secret)
      const body = JSON.stringify({ identifier: "+12139992143", kind: "phone", magic_link: magicLink });
      const ts = String(Math.floor(Date.now() / 1000));
      const wrongSig = createHmac("sha256", SIGNUP_SECRET).update(`${ts}\n${body}`).digest("hex");
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-signature": wrongSig, "x-timestamp": ts },
        body,
      });
      expect(res.status).toBe(401);
    });

    test("error message does not leak magic_link on send failure", async () => {
      ctx.sendToPhone.mockRejectedValueOnce(new Error(`failed to send to ${magicLink}`));
      const body = JSON.stringify({
        identifier: "+12139992143",
        kind: "phone",
        magic_link: magicLink,
      });
      const res = await fetch(`${BASE}/webhook/magic-link-send`, {
        method: "POST",
        headers: magicHeaders(body),
        body,
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(magicLink);
    });
  });

  describe("verifyTimestampedHmacSignature (pure helper)", () => {
    const SECRET = "test-magic-link-secret-do-not-use";
    function tSig(body: string, ts: number): string {
      return createHmac("sha256", SECRET).update(`${ts}\n${body}`).digest("hex");
    }

    test("valid sig + fresh ts → ok", () => {
      const body = '{"x":1}';
      const ts = 1714000000;
      const result = verifyTimestampedHmacSignature(body, tSig(body, ts), String(ts), SECRET, { nowSec: ts });
      expect(result.ok).toBe(true);
    });

    test("stale ts (skew exceeded) → ts_stale", () => {
      const body = '{"x":1}';
      const ts = 1714000000;
      const result = verifyTimestampedHmacSignature(body, tSig(body, ts), String(ts), SECRET, {
        nowSec: ts + 600,  // 10분 후
        skewSec: 300,
      });
      expect(result).toEqual({ ok: false, reason: "ts_stale" });
    });

    test("future ts → ts_future", () => {
      const body = '{"x":1}';
      const ts = 1714000000;
      const result = verifyTimestampedHmacSignature(body, tSig(body, ts), String(ts), SECRET, {
        nowSec: ts - 120,  // 2분 전
        futureSec: 60,
      });
      expect(result).toEqual({ ok: false, reason: "ts_future" });
    });

    test("non-numeric ts → ts_format", () => {
      const result = verifyTimestampedHmacSignature("{}", "0".repeat(64), "abc", SECRET);
      expect(result).toEqual({ ok: false, reason: "ts_format" });
    });

    test("array sig header → sig_array", () => {
      const result = verifyTimestampedHmacSignature("{}", ["a", "b"], "1714000000", SECRET);
      expect(result).toEqual({ ok: false, reason: "sig_array" });
    });

    test("array ts header → ts_array", () => {
      const result = verifyTimestampedHmacSignature("{}", "0".repeat(64), ["1", "2"], SECRET);
      expect(result).toEqual({ ok: false, reason: "ts_array" });
    });

    test("body tampering → sig_mismatch", () => {
      const ts = 1714000000;
      const sig = tSig('{"x":1}', ts);
      const result = verifyTimestampedHmacSignature(
        '{"x":2}',  // body 변조
        sig,
        String(ts),
        SECRET,
        { nowSec: ts },
      );
      expect(result).toEqual({ ok: false, reason: "sig_mismatch" });
    });

    test("ts tampering breaks sig (timestamp bound to sig input)", () => {
      const ts = 1714000000;
      const sig = tSig('{"x":1}', ts);
      const result = verifyTimestampedHmacSignature(
        '{"x":1}',
        sig,
        String(ts + 1),  // ts 변조 (skew 안엔 들어가지만 sig 가 바뀜)
        SECRET,
        { nowSec: ts + 1 },
      );
      expect(result).toEqual({ ok: false, reason: "sig_mismatch" });
    });

    test("empty secret → no_secret", () => {
      const result = verifyTimestampedHmacSignature("{}", "0".repeat(64), "1714000000", "");
      expect(result).toEqual({ ok: false, reason: "no_secret" });
    });
  });

  describe("verifyHmacSignature (pure helper)", () => {
    test("valid signature → true", () => {
      const body = '{"x":1}';
      expect(verifyHmacSignature(body, signupSig(body), SIGNUP_SECRET)).toBe(true);
    });

    test("wrong signature → false", () => {
      expect(verifyHmacSignature('{"x":1}', "0".repeat(64), SIGNUP_SECRET)).toBe(false);
    });

    test("array header (rare proxy bug) → false", () => {
      const body = '{"x":1}';
      expect(verifyHmacSignature(body, [signupSig(body), signupSig(body)], SIGNUP_SECRET)).toBe(false);
    });

    test("undefined header → false", () => {
      expect(verifyHmacSignature('{"x":1}', undefined, SIGNUP_SECRET)).toBe(false);
    });

    test("empty secret → false", () => {
      expect(verifyHmacSignature('{"x":1}', signupSig('{"x":1}'), "")).toBe(false);
    });

    test("malformed hex → false (early reject)", () => {
      // Hex 가 아닌 char 포함, 길이만 맞춤 (64 char)
      const malformed = "Z".repeat(64);
      expect(verifyHmacSignature('{"x":1}', malformed, SIGNUP_SECRET)).toBe(false);
    });
  });
});
