import { readFile } from "node:fs/promises";
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

export async function buildSystemPrompt(): Promise<string> {
  const ws = config.workspace;
  const maxChars = config.maxFileChars;

  const files: Array<{ label: string; path: string }> = [
    { label: "SOUL", path: join(ws, "SOUL.md") },
    { label: "USER", path: join(ws, "USER.md") },
    { label: "IDENTITY", path: join(ws, "IDENTITY.md") },
    { label: "RULES", path: join(ws, "memory", "lessons", "master-rules.md") },
  ];

  // Today and yesterday daily files
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  files.push({
    label: `DAILY (${formatDate(today)})`,
    path: join(ws, "memory", "daily", `${formatDate(today)}.md`),
  });
  files.push({
    label: `DAILY (${formatDate(yesterday)})`,
    path: join(ws, "memory", "daily", `${formatDate(yesterday)}.md`),
  });

  const sections: string[] = [];
  for (const { label, path } of files) {
    const content = await loadFileOrNull(path);
    if (content) {
      sections.push(`## ${label}\n${truncate(content.trim(), maxChars)}`);
    }
  }

  return sections.join("\n\n");
}
