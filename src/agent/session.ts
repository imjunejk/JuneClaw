import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config, type TaskType } from "../config.js";

interface SessionEntry {
  sessionId: string;
  model: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

interface SessionStore {
  [phone: string]: Partial<Record<TaskType, SessionEntry>>;
}

async function loadStore(): Promise<SessionStore> {
  try {
    const data = await readFile(config.paths.sessions, "utf-8");
    const raw = JSON.parse(data) as Record<string, unknown>;

    // Migrate legacy format: {phone: "sessionId"} → {phone: {general: {...}}}
    const store: SessionStore = {};
    for (const [phone, value] of Object.entries(raw)) {
      if (typeof value === "string") {
        store[phone] = {
          general: {
            sessionId: value,
            model: config.claude.modelRouting?.general ?? "default",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            messageCount: 0,
          },
        };
      } else if (value && typeof value === "object") {
        store[phone] = value as Partial<Record<TaskType, SessionEntry>>;
      }
    }
    return store;
  } catch {
    return {};
  }
}

async function saveStore(store: SessionStore): Promise<void> {
  await mkdir(dirname(config.paths.sessions), { recursive: true, mode: 0o700 });
  await writeFile(
    config.paths.sessions,
    JSON.stringify(store, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
}

/** Get session ID for a specific phone + task type. */
export async function getSessionId(
  phone: string,
  taskType?: TaskType,
): Promise<string | undefined> {
  const store = await loadStore();
  const entries = store[phone];
  if (!entries) return undefined;

  if (taskType) {
    return entries[taskType]?.sessionId;
  }

  // Legacy fallback: return any active session (general first)
  return entries.general?.sessionId
    ?? entries.coding?.sessionId
    ?? entries.research?.sessionId;
}

/** Set or update session entry for a phone + task type. */
export async function setSessionId(
  phone: string,
  sessionId: string,
  taskType: TaskType = "general",
  model?: string,
): Promise<void> {
  const store = await loadStore();
  if (!store[phone]) store[phone] = {};

  const existing = store[phone][taskType];
  const now = new Date().toISOString();

  store[phone][taskType] = {
    sessionId,
    model: model ?? existing?.model ?? config.claude.modelRouting[taskType],
    createdAt: existing?.createdAt ?? now,
    lastActiveAt: now,
    messageCount: (existing?.messageCount ?? 0) + 1,
  };

  await saveStore(store);
}

/** Clear session for a specific task type, or all sessions for a phone. */
export async function clearSessionId(
  phone: string,
  taskType?: TaskType,
): Promise<void> {
  const store = await loadStore();
  if (!store[phone]) return;

  if (taskType) {
    delete store[phone][taskType];
  } else {
    delete store[phone];
  }

  await saveStore(store);
}

/** Get all active session entries for a phone number. */
export async function getSessionEntries(
  phone: string,
): Promise<Partial<Record<TaskType, SessionEntry>>> {
  const store = await loadStore();
  return store[phone] ?? {};
}

/** Get a specific session entry with full metadata. */
export async function getSessionEntry(
  phone: string,
  taskType: TaskType,
): Promise<SessionEntry | undefined> {
  const store = await loadStore();
  return store[phone]?.[taskType];
}

/** Clean up expired sessions based on idle timeout and max age. */
export async function cleanupExpiredSessions(phone: string): Promise<string[]> {
  const store = await loadStore();
  const entries = store[phone];
  if (!entries) return [];

  const now = Date.now();
  const cleaned: string[] = [];

  for (const [type, entry] of Object.entries(entries) as [TaskType, SessionEntry][]) {
    const lastActive = new Date(entry.lastActiveAt).getTime();
    const idleTimeout = config.sessionPool.idleTimeouts[type];
    const maxAge = config.sessionPool.maxSessionAge;

    const idleExpired = idleTimeout > 0 && (now - lastActive) > idleTimeout;
    const ageExpired = (now - lastActive) > maxAge;

    if (idleExpired || ageExpired) {
      delete entries[type];
      cleaned.push(type);
    }
  }

  if (cleaned.length > 0) {
    await saveStore(store);
  }

  return cleaned;
}
