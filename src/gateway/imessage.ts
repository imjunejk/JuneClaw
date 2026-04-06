import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "../config.js";
import { AsyncMutex } from "../lib/async-mutex.js";
import { atomicWriteJson } from "../lib/atomic-file.js";
import type { IncomingMessage, Channel } from "./types.js";

const execFileAsync = promisify(execFile);

/** execFileAsync with a timeout — kills the child if it exceeds `ms`. */
function execWithTimeout(
  cmd: string,
  args: string[],
  ms: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: ms, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if ((err as any).killed || err.message.includes("ETIMEDOUT")) {
          reject(new Error(`${cmd} timed out after ${ms}ms`));
        } else {
          reject(err);
        }
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const IMSG_TIMEOUT_MS = 30_000; // 30 seconds

interface ImsgMessage {
  id: number;
  guid: string;
  chat_id: number;
  text: string | null;
  sender: string;
  is_from_me: boolean;
  created_at: string;
}

type LastSeenStore = Record<string, number>; // chatId → lastSeenRowId

// Mutex for lastSeen store — prevents read-modify-write races on restart/concurrent polls
const lastSeenMutex = new AsyncMutex();

async function loadLastSeenStore(): Promise<LastSeenStore> {
  try {
    const data = await readFile(config.paths.lastSeen, "utf-8");
    return JSON.parse(data) as LastSeenStore;
  } catch {
    return {};
  }
}

async function saveLastSeenStore(store: LastSeenStore): Promise<void> {
  await atomicWriteJson(config.paths.lastSeen, store);
}

export function createIMessageChannel(
  phone: string,
  chatId: number,
): Channel {
  let lastSeenId: number | null = null;

  return {
    async pollNewMessages(): Promise<IncomingMessage[]> {
      return lastSeenMutex.run(async () => {
        if (lastSeenId === null) {
          const store = await loadLastSeenStore();
          lastSeenId = store[String(chatId)] ?? 0;
        }

        const { stdout } = await execWithTimeout("imsg", [
          "history",
          "--chat-id",
          String(chatId),
          "--limit",
          "20",
          "--json",
        ], IMSG_TIMEOUT_MS);

        const messages: ImsgMessage[] = [];
        for (const line of stdout.trim().split("\n").filter(Boolean)) {
          try {
            messages.push(JSON.parse(line));
          } catch {
            // Skip malformed JSON lines from imsg
          }
        }

        const newMessages = messages
          .filter((m) => m.id > lastSeenId! && !m.is_from_me && m.text)
          .sort((a, b) => a.id - b.id);

        if (newMessages.length > 0) {
          const maxId = Math.max(...newMessages.map((m) => m.id));
          lastSeenId = maxId;
          const store = await loadLastSeenStore();
          store[String(chatId)] = maxId;
          await saveLastSeenStore(store);
        }

        return newMessages.map((m) => ({
          id: m.id,
          guid: m.guid,
          chatId: m.chat_id,
          text: m.text!,
          sender: m.sender,
          isFromMe: m.is_from_me,
          createdAt: m.created_at,
        }));
      });
    },

    async sendMessage(text: string): Promise<void> {
      const maxLen = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.slice(i, i + maxLen));
      }

      for (const chunk of chunks) {
        await execWithTimeout("imsg", ["send", "--to", phone, "--text", chunk], IMSG_TIMEOUT_MS);
      }
    },
  };
}
