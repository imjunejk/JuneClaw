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

const BRIDGE_PORT = Number(process.env.JUNECLAW_BRIDGE_PORT) || 3200;
const BRIDGE_HOST = "127.0.0.1";
const ALLOW_WRITE = process.env.JUNECLAW_BRIDGE_ALLOW_WRITE === "1";
const MAX_BODY_SIZE = 1_000_000; // 1 MB

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
