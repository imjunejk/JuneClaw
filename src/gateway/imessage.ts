import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { IncomingMessage, Channel } from "./types.js";

const execFileAsync = promisify(execFile);

interface ImsgChat {
  id: number;
  identifier: string;
  service: string;
}

interface ImsgMessage {
  id: number;
  guid: string;
  chat_id: number;
  text: string | null;
  sender: string;
  is_from_me: boolean;
  created_at: string;
}

async function resolveChatId(phone: string): Promise<number> {
  const { stdout } = await execFileAsync("imsg", ["chats", "--json"]);
  const chats: ImsgChat[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line: string) => JSON.parse(line));

  const match = chats.find((c) => c.identifier === phone);
  if (!match) {
    throw new Error(`No iMessage chat found for ${phone}`);
  }
  return match.id;
}

async function loadLastSeenId(): Promise<number> {
  try {
    const data = await readFile(config.lastSeenPath, "utf-8");
    const parsed = JSON.parse(data) as { lastSeenId: number };
    return parsed.lastSeenId;
  } catch {
    return 0;
  }
}

async function saveLastSeenId(id: number): Promise<void> {
  await mkdir(dirname(config.lastSeenPath), { recursive: true });
  await writeFile(
    config.lastSeenPath,
    JSON.stringify({ lastSeenId: id }),
    "utf-8",
  );
}

export function createIMessageChannel(phone: string): Channel {
  let chatId: number | null = null;
  let lastSeenId: number | null = null;

  return {
    async pollNewMessages(): Promise<IncomingMessage[]> {
      if (chatId === null) {
        chatId = await resolveChatId(phone);
      }
      if (lastSeenId === null) {
        lastSeenId = await loadLastSeenId();
      }

      const { stdout } = await execFileAsync("imsg", [
        "history",
        "--chat-id",
        String(chatId),
        "--limit",
        "20",
        "--json",
      ]);

      const messages: ImsgMessage[] = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line: string) => JSON.parse(line));

      // Filter to only new messages from the other person (not from me)
      const newMessages = messages
        .filter((m) => m.id > lastSeenId! && !m.is_from_me && m.text)
        .sort((a, b) => a.id - b.id);

      if (newMessages.length > 0) {
        const maxId = Math.max(...newMessages.map((m) => m.id));
        lastSeenId = maxId;
        await saveLastSeenId(maxId);
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
    },

    async sendMessage(text: string): Promise<void> {
      // Split long messages (iMessage has practical limits)
      const maxLen = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.slice(i, i + maxLen));
      }

      for (const chunk of chunks) {
        await execFileAsync("imsg", [
          "send",
          "--to",
          phone,
          "--text",
          chunk,
        ]);
      }
    },
  };
}
