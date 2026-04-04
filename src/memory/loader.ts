import { readFile, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

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

interface ImsgHistoryMessage {
  id: number;
  text: string | null;
  sender: string;
  is_from_me: boolean;
  created_at: string;
}

async function fetchRecentMessages(): Promise<string | null> {
  try {
    const chatId = config.channels.june.chatId;
    const { stdout } = await execFileAsync("imsg", [
      "history",
      "--chat-id",
      String(chatId),
      "--limit",
      "10",
      "--json",
    ]);

    if (!stdout || !stdout.trim()) return null;

    const messages: ImsgHistoryMessage[] = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));

    if (messages.length === 0) return null;

    messages.sort((a, b) => a.id - b.id);

    const lines = messages
      .filter((m) => m.text)
      .map((m) => {
        const time = new Date(m.created_at).toLocaleTimeString("en-US", {
          timeZone: "America/Los_Angeles",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const sender = m.is_from_me ? "Youngsu" : m.sender;
        return `[${time}] ${sender}: ${m.text}`;
      });

    if (lines.length === 0) return null;

    return `<recent_conversation>\n${lines.join("\n")}\n</recent_conversation>`;
  } catch {
    return null;
  }
}

async function findMostRecent(dir: string): Promise<string | null> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) return null;
    return loadFileOrNull(join(dir, files[files.length - 1]!));
  } catch {
    return null;
  }
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
    { label: "SUB_AGENTS", path: join(ws, "SUB_AGENTS.md"), maxChars: 10000 },
    {
      label: "OPERATING PRINCIPLES",
      path: join(ws, "docs", "operating-principles.md"),
      maxChars: 5000,
    },
    {
      label: "SESSION MANAGEMENT",
      path: join(ws, "docs", "session-management.md"),
      maxChars: 4000,
    },
    {
      label: "COMMUNICATION RULES",
      path: join(ws, "docs", "communication-rules.md"),
      maxChars: 5000,
    },
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
    {
      label: "HEARTBEAT",
      path: join(ws, "HEARTBEAT.md"),
      maxChars: 3000,
    },
  ];

  // Add strategy files for sub-agent orchestration
  const strategyFiles: FileSpec[] = [
    {
      label: "STRATEGY: DEV-TEAM (Youngsu)",
      path: join(config.subAgents.strategiesPath, "dev-team-youngsu.md"),
      maxChars: 8000,
    },
    {
      label: "STRATEGY: DEV-TEAM (Common)",
      path: join(config.subAgents.strategiesPath, "dev-team-common.md"),
      maxChars: 5000,
    },
    {
      label: "STRATEGY: DEV-TEAM (Process)",
      path: join(config.subAgents.strategiesPath, "dev-team-process.md"),
      maxChars: 5000,
    },
  ];

  const sections: string[] = [];
  for (const { label, path, maxChars, deleteAfterLoad } of [
    ...files,
    ...strategyFiles,
  ]) {
    const content = await loadFileOrNull(path);
    if (content) {
      sections.push(`## ${label}\n${truncate(content.trim(), maxChars)}`);
      if (deleteAfterLoad) {
        try {
          await unlink(path);
        } catch {
          // ignore
        }
      }
    }
  }

  // Load skill definitions from .openclaw/skills/
  const skillsDir = join(ws, ".openclaw", "skills");
  try {
    const skillEntries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      const content = await loadFileOrNull(skillPath);
      if (content) {
        sections.push(
          `## SKILL: ${entry.name}\n${truncate(content.trim(), 2000)}`,
        );
      }
    }
  } catch {
    // No skills directory
  }

  // Add most recent weekly/monthly summaries for long-term memory
  const weeklyDir = join(ws, "memory", "weekly");
  const monthlyDir = join(ws, "memory", "monthly");

  const recentWeekly = await findMostRecent(weeklyDir);
  if (recentWeekly) {
    sections.push(
      `## WEEKLY SUMMARY (latest)\n${truncate(recentWeekly.trim(), 4000)}`,
    );
  }

  const recentMonthly = await findMostRecent(monthlyDir);
  if (recentMonthly) {
    sections.push(
      `## MONTHLY SUMMARY (latest)\n${truncate(recentMonthly.trim(), 3000)}`,
    );
  }

  const workspaceContext = `<workspace_context>\n${sections.join("\n\n")}\n</workspace_context>`;

  const conversationHistory = await fetchRecentMessages();

  const phone = config.channels.june.phone;
  const toolsPath = config.subAgents.toolsPath;
  const runtimeContext = `<runtime_context>
Time: ${formatTimePT(today)}
Channel: iMessage from ${senderName} (${phone})
You are Youngsu. Respond in the style defined in SOUL.md.
You have Bash tool — use it to call: imsg, gh, memo, remindctl, things, weather via wttr.in

Message delivery: The daemon auto-sends your text response as an iMessage. Do NOT also send it yourself via "imsg send" — that causes duplicates. Only use "imsg send" for PROACTIVE messages (alerts, news, broadcasts to other recipients) that are separate from your reply to the current message.

Sub-agent delegation (use Agent tool):
- Read strategies/dev-team-{name}.md for each sub-agent's role-specific prompt before delegating
- Agent lifecycle: Bash("${toolsPath}/agent-lifecycle.sh register|complete|cascade-kill|status|orphans|archive")
- Agent mailbox: Bash("${toolsPath}/mailbox.sh send|read|peek|broadcast|list")
- Max concurrent sub-agents: ${config.subAgents.maxConcurrent}

Send iMessage (proactive only): Bash("imsg send --to ${phone} --text \\"...\\"")
</runtime_context>`;

  const parts = [workspaceContext];
  if (conversationHistory) {
    parts.push(conversationHistory);
  }
  parts.push(runtimeContext);

  const prompt = parts.join("\n\n");
  const PROMPT_WARN_THRESHOLD = 80_000;
  if (prompt.length > PROMPT_WARN_THRESHOLD) {
    console.warn(
      `[loader] system prompt is ${prompt.length} chars (threshold: ${PROMPT_WARN_THRESHOLD})`,
    );
  }
  return prompt;
}
