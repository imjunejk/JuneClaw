import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

interface SessionStore {
  [phone: string]: string; // phone → session ID
}

async function loadStore(): Promise<SessionStore> {
  try {
    const data = await readFile(config.sessionStorePath, "utf-8");
    return JSON.parse(data) as SessionStore;
  } catch {
    return {};
  }
}

async function saveStore(store: SessionStore): Promise<void> {
  await mkdir(dirname(config.sessionStorePath), { recursive: true });
  await writeFile(config.sessionStorePath, JSON.stringify(store), "utf-8");
}

export async function getSessionId(
  phone: string,
): Promise<string | undefined> {
  const store = await loadStore();
  return store[phone];
}

export async function setSessionId(
  phone: string,
  sessionId: string,
): Promise<void> {
  const store = await loadStore();
  store[phone] = sessionId;
  await saveStore(store);
}
