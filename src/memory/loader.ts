import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

async function loadFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

function formatTimePT(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

interface FileSpec {
  label: string;
  path: string;
  maxChars: number;
  deleteAfterLoad?: boolean;
}

export async function buildSystemPrompt(
  channelId: string,
  senderName: string,
): Promise<string> {
  const ws = config.workspace;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const files: FileSpec[] = [
    { label: "SOUL", path: join(ws, "SOUL.md"), maxChars: 8000 },
    { label: "IDENTITY", path: join(ws, "IDENTITY.md"), maxChars: 3000 },
    { label: "USER", path: join(ws, "USER.md"), maxChars: 3000 },
    { label: "AGENTS", path: join(ws, "AGENTS.md"), maxChars: 5000 },
    {
      label: "MASTER RULES",
      path: join(ws, "memory", "lessons", "master-rules.md"),
      maxChars: 10000,
    },
    {
      label: `DAILY (${formatDate(today)})`,
      path: join(ws, "memory", "daily", `${formatDate(today)}.md`),
      maxChars: 8000,
    },
    {
      label: `DAILY (${formatDate(yesterday)})`,
      path: join(ws, "memory", "daily", `${formatDate(yesterday)}.md`),
      maxChars: 4000,
    },
    {
      label: "HANDOFF",
      path: join(ws, "HANDOFF.md"),
      maxChars: 5000,
      deleteAfterLoad: true,
    },
    {
      label: "YSU CHECKLIST",
      path: join(ws, "checklists", "YSU-CHECKLIST.md"),
      maxChars: 3000,
    },
  ];

  const sections: string[] = [];
  for (const { label, path, maxChars, deleteAfterLoad } of files) {
    const content = await loadFileOrNull(path);
    if (content) {
      sections.push(`## ${label}\n${truncate(content.trim(), maxChars)}`);
      if (deleteAfterLoad) {
        try {
          await unlink(path);
        } catch {
          // ignore if already deleted
        }
      }
    }
  }

  const workspaceContext = `<workspace_context>\n${sections.join("\n\n")}\n</workspace_context>`;

  const phone = config.channels.june.phone;
  const runtimeContext = `<runtime_context>
Time: ${formatTimePT(today)}
Channel: iMessage from ${senderName} (${phone})
You are Youngsu. Respond in the style defined in SOUL.md.
You have Bash tool — use it to call: imsg, gh, memo, remindctl, things, weather via wttr.in
For background tasks: use Agent tool to spawn sub-agents
Send iMessage: Bash("imsg send --to ${phone} --text \\"...\\"")
</runtime_context>`;

  return `${workspaceContext}\n\n${runtimeContext}`;
}
