/**
 * JuneClaw Bridge Server
 *
 * Lightweight HTTP server for external tools (Hustle, etc.) to control
 * the JuneClaw daemon.
 *
 * DESIGN PRINCIPLES:
 * - Localhost only (127.0.0.1). Never binds to 0.0.0.0.
 * - All routes wrapped in try/catch. Bridge crashes do NOT affect daemon.
 * - Write operations are opt-in via BRIDGE_ALLOW_WRITE env var.
 * - No authentication currently (localhost-only trust model).
 * - No CORS: loopback clients don't need it, and a wildcard origin would
 *   expose the bridge to any web page the user visits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const BRIDGE_PORT = Number(process.env.JUNECLAW_BRIDGE_PORT) || 3200;
const BRIDGE_HOST = "127.0.0.1";
const ALLOW_WRITE = process.env.JUNECLAW_BRIDGE_ALLOW_WRITE === "1";
const MAX_BODY_SIZE = 1_000_000; // 1 MB

// Signup webhook — galleon.market 가입 요청 수신용.
// HMAC-SHA256 (hex) 시그니처 검증 — 노출 endpoint (cloudflared tunnel) 보호.
// June 의 phone (config.channels.june.phone) 으로 iMessage 자동 전송.
const SIGNUP_WEBHOOK_SECRET = process.env.JUNECLAW_SIGNUP_WEBHOOK_SECRET ?? "";

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 1MB limit");
    this.name = "BodyTooLargeError";
  }
}

class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyParseError";
  }
}

// Defense in depth: if someone later refactors BRIDGE_HOST to read from an
// env var, fail loudly rather than silently bind to 0.0.0.0.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(BRIDGE_HOST)) {
  throw new Error(`Bridge refuses non-loopback host: ${BRIDGE_HOST}`);
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

interface BridgeContext {
  sendMessage?: (channelName: string, text: string) => Promise<void>;
  sendToPhone?: (phone: string, text: string) => Promise<void>;
  enqueueMessage?: (channelName: string, text: string, taskType?: string) => Promise<string>;
  getChannels?: () => Array<{ name: string; phone: string; chatId: number; accessLevel: string }>;
}

const routes = new Map<string, Handler>();
let context: BridgeContext = {};

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        aborted = true;
        reject(new BodyTooLargeError());
        // Don't destroy the socket here — the route handler still needs to
        // write a 413 response. Subsequent data chunks are ignored.
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new BodyParseError(err instanceof Error ? err.message : String(err)));
      }
    });
    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}

/**
 * Map readBody() errors to appropriate HTTP responses.
 * Returns true if the error was handled (response sent), false otherwise.
 */
function handleBodyError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof BodyTooLargeError) {
    json(res, 413, { error: err.message });
    return true;
  }
  if (err instanceof BodyParseError) {
    json(res, 400, { error: `Invalid JSON: ${err.message}` });
    return true;
  }
  return false;
}

// ─── Routes ─────────────────────────────────────────────
routes.set("GET /bridge/health", (_req, res) => {
  json(res, 200, { status: "ok", pid: process.pid, uptime: process.uptime() });
});

routes.set("GET /bridge/channels", (_req, res) => {
  if (!context.getChannels) return json(res, 503, { error: "getChannels not wired" });
  json(res, 200, context.getChannels());
});

routes.set("POST /bridge/message", async (req, res) => {
  if (!ALLOW_WRITE) return json(res, 403, { error: "Write operations disabled. Set JUNECLAW_BRIDGE_ALLOW_WRITE=1" });
  if (!context.sendMessage) return json(res, 503, { error: "sendMessage not wired" });

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    if (handleBodyError(res, err)) return;
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const channel = body.channel as string;
    const text = body.text as string;
    if (!channel || !text) return json(res, 400, { error: "Missing channel or text" });

    await context.sendMessage(channel, text);
    json(res, 200, { ok: true, channel, length: text.length });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

routes.set("POST /bridge/send-to-phone", async (req, res) => {
  if (!ALLOW_WRITE) return json(res, 403, { error: "Write operations disabled" });
  if (!context.sendToPhone) return json(res, 503, { error: "sendToPhone not wired" });

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    if (handleBodyError(res, err)) return;
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const phone = body.phone as string;
    const text = body.text as string;
    if (!phone || !text) return json(res, 400, { error: "Missing phone or text" });

    await context.sendToPhone(phone, text);
    json(res, 200, { ok: true, phone: phone.slice(0, 4) + "***" + phone.slice(-4) });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Galleon 가입 요청 webhook ────────────────────────────
// galleon.market 의 CF Pages Function 이 미등록 사용자 가입 요청을 보내면
// June 에게 iMessage 알림. 외부 노출 (cloudflared) 가정 — HMAC 검증 필수.
//
// 흐름:
//   CF Function POST → cloudflared tunnel → bridge POST /webhook/signup-request
//   header: x-signature: <HMAC-SHA256-hex of raw body using SIGNUP_WEBHOOK_SECRET>
//   body  : {identifier, kind, display, name?, requested_at, user_agent?, ip?}
//   → June iMessage
//
// 미설정 (SIGNUP_WEBHOOK_SECRET 비어 있음) 시 404 (endpoint 노출 회피).

/** Raw body 읽기 — HMAC 비교용. JSON.parse 후 재직렬화 시 byte 변동 위험으로 직접 처리. */
async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        aborted = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}

/**
 * Signup webhook HMAC 검증 — pure 함수 (테스트 가능).
 *
 * Minor #1: Array.isArray guard — 이론상 string[] 가능 (Node parser 가 보통
 *   comma-join 하지만 명시적으로 처리).
 * Minor #2: Buffer.from(hex, "hex") 로 명시적 hex 디코딩 (UTF-8 default 보다
 *   idiomatic + malformed hex early reject).
 *
 * @returns true 면 유효, false 면 거절
 */
export function verifySignupSignature(
  rawBody: string,
  providedHeader: string | string[] | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (Array.isArray(providedHeader)) return false;  // 다중 헤더 즉시 거절
  const provided = providedHeader ?? "";
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // 길이 mismatch — timingSafeEqual 호출 전 prepass (timingSafeEqual 은 길이 다르면 throw)
  if (provided.length !== expected.length) return false;
  // hex 디코딩 — malformed hex 도 여기서 catch
  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
    expectedBuf = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  // hex 디코딩 후 길이 또 체크 (malformed 면 짧아질 수 있음)
  if (providedBuf.length !== expectedBuf.length) return false;
  if (providedBuf.length === 0) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

routes.set("POST /webhook/signup-request", async (req, res) => {
  // Minor #3: SECRET 미설정 시 404 — endpoint 존재 자체 미노출 (이전 503 대비 tighter).
  if (!SIGNUP_WEBHOOK_SECRET) {
    return json(res, 404, { error: "Not found" });
  }
  if (!context.sendToPhone) {
    return json(res, 503, { error: "sendToPhone not wired" });
  }

  let raw: string;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    if (handleBodyError(res, err)) return;
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }

  if (!verifySignupSignature(raw, req.headers["x-signature"], SIGNUP_WEBHOOK_SECRET)) {
    return json(res, 401, { error: "invalid signature" });
  }

  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return json(res, 400, { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
  }

  const display = String(body.display ?? body.identifier ?? "").slice(0, 80);
  // Minor #1 / Nit: kind 가 "email" 외 모든 값 → Phone (default). 빈 문자열 / undefined / 잘못된 값 모두 동일.
  const kind = String(body.kind ?? "").slice(0, 10);
  const name = String(body.name ?? "").slice(0, 40);
  // Nit: requested_at 도 다른 필드처럼 길이 cap (40 chars — ISO timestamp 27자 충분).
  const requestedAt = String(body.requested_at ?? new Date().toISOString()).slice(0, 40);
  const ip = String(body.ip ?? "").slice(0, 64);
  if (!display) return json(res, 400, { error: "missing identifier/display" });

  const text = [
    "🆕 갈레온 가입 요청",
    `${kind === "email" ? "✉️ Email" : "📱 Phone"}: ${display}`,
    name ? `이름: ${name}` : null,
    `요청: ${requestedAt}`,
    ip ? `IP: ${ip}` : null,
    "",
    "승인 시 LOGIN_ALLOWLIST env var 에 추가 (CF dashboard).",
  ].filter(Boolean).join("\n");

  try {
    await context.sendToPhone(config.channels.june.phone, text);
    // Minor #4: PII echo 제거 — masked phone 도 식별 정보. 단순 ok.
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

routes.set("POST /bridge/enqueue", async (req, res) => {
  if (!ALLOW_WRITE) return json(res, 403, { error: "Write operations disabled" });
  if (!context.enqueueMessage) return json(res, 503, { error: "enqueueMessage not wired" });

  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    if (handleBodyError(res, err)) return;
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    const channel = body.channel as string;
    const text = body.text as string;
    const taskType = body.taskType as string | undefined;
    if (!channel || !text) return json(res, 400, { error: "Missing channel or text" });

    const id = await context.enqueueMessage(channel, text, taskType);
    json(res, 200, { ok: true, id });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Start ──────────────────────────────────────────────
export function startBridge(ctx: BridgeContext = {}) {
  context = ctx;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
      const key = `${req.method} ${url.pathname}`;
      const handler = routes.get(key);
      if (!handler) return json(res, 404, { error: "Not found", key });
      await handler(req, res, url);
    } catch (err) {
      // Bridge errors must NEVER escape to the daemon
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.on("error", (err) => {
    console.warn(`[Bridge] Server error (non-fatal):`, err.message);
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`[Bridge] Listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}${ALLOW_WRITE ? " (WRITES ENABLED)" : " (read-only)"}`);
  });

  return server;
}

export function updateBridgeContext(patch: Partial<BridgeContext>) {
  context = { ...context, ...patch };
}
