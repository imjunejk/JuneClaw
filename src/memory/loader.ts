import { readFile, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config, resolveChannelConfig, type TaskType } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * Truncate `text` to `maxChars`, keeping either the head (default) or the
 * tail. For append-only logs like the daily journal, `"tail"` keeps the
 * most recent content — with `"head"` the loader was showing the oldest
 * entries of the day and dropping the most relevant recent activity.
 */
function truncate(
  text: string,
  maxChars: number,
  from: "head" | "tail" = "head",
): string {
  if (text.length <= maxChars) return text;
  if (from === "tail") {
    return "...[earlier entries truncated]\n" + text.slice(text.length - maxChars);
  }
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
    timeZone: config.timezone,
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
  truncateFrom?: "head" | "tail";
}

interface ImsgHistoryMessage {
  id: number;
  text: string | null;
  sender: string;
  is_from_me: boolean;
  created_at: string;
}

async function fetchRecentMessages(chatId?: number): Promise<string | null> {
  try {
    const resolvedChatId = chatId ?? config.channels.june.chatId;
    const { stdout } = await execFileAsync("imsg", [
      "history",
      "--chat-id",
      String(resolvedChatId),
      "--limit",
      "10",
      "--json",
    ], { timeout: 15_000 });

    if (!stdout || !stdout.trim()) return null;

    const messages: ImsgHistoryMessage[] = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      try { messages.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    if (messages.length === 0) return null;

    messages.sort((a, b) => a.id - b.id);

    const lines = messages
      .filter((m) => m.text)
      .map((m) => {
        const time = new Date(m.created_at).toLocaleTimeString("en-US", {
          timeZone: config.timezone,
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

// ── Static Prompt Cache ──────────────────────────────────────
// Claude API caches prompt prefixes by byte-identical matching.
// By splitting the system prompt into STATIC (persona, rules, strategies)
// and DYNAMIC (daily logs, conversation, runtime state), we ensure the
// static prefix hits the cache on every call → ~90% token cost reduction
// on the cached portion.

interface PromptCache {
  hash: string;
  content: string;
}

const staticCache = new Map<string, PromptCache>();

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Build the STATIC portion of the system prompt.
 * This content changes rarely (only when persona/strategy files are edited)
 * and is the same across consecutive calls with the same taskType.
 *
 * Sections are sorted alphabetically by label within each group to maintain
 * byte-identical ordering — if the order shifts, the API cache breaks.
 */
async function buildStaticPrompt(taskType: TaskType, channelId?: string): Promise<string> {
  const ws = config.workspace;

  const channelConfig = resolveChannelConfig(channelId ?? "june");
  const isRestricted = channelConfig.accessLevel === "general";

  if (isRestricted) {
    // Lightweight persona for restricted channels (e.g. hamtol)
    const personaPath = join(ws, "personas", `${channelId}.md`);
    const persona = await loadFileOrNull(personaPath);
    const sections: string[] = [];
    if (persona) {
      sections.push(`## PERSONA\n${truncate(persona.trim(), 5000)}`);
    } else {
      console.warn(`[loader] persona file missing for restricted channel "${channelId}": ${personaPath}`);
    }
    return sections.join("\n\n");
  }

  // Full identity for unrestricted channels (june)
  const coreFiles: FileSpec[] = [
    { label: "AGENTS", path: join(ws, "AGENTS.md"), maxChars: 5000 },
    { label: "COMMUNICATION RULES", path: join(ws, "docs", "communication-rules.md"), maxChars: 5000 },
    { label: "HEARTBEAT", path: join(ws, "HEARTBEAT.md"), maxChars: 3000 },
    { label: "IDENTITY", path: join(ws, "IDENTITY.md"), maxChars: 3000 },
    { label: "MASTER RULES", path: join(ws, "memory", "lessons", "master-rules.md"), maxChars: 10000 },
    { label: "OPERATING PRINCIPLES", path: join(ws, "docs", "operating-principles.md"), maxChars: 5000 },
    { label: "SESSION MANAGEMENT", path: join(ws, "docs", "session-management.md"), maxChars: 4000 },
    { label: "SOUL", path: join(ws, "SOUL.md"), maxChars: 8000 },
    { label: "SUB_AGENTS", path: join(ws, "SUB_AGENTS.md"), maxChars: 10000 },
    { label: "USER", path: join(ws, "USER.md"), maxChars: 3000 },
    { label: "YSU CHECKLIST", path: join(ws, "checklists", "YSU-CHECKLIST.md"), maxChars: 3000 },
  ];

  // Strategy files — already sorted in config, but ensure alphabetical
  const strategyEntries = [...config.subAgents.strategyMapping[taskType]]
    .sort((a, b) => a.label.localeCompare(b.label));
  const strategyFiles: FileSpec[] = strategyEntries.map((entry) => ({
    label: `STRATEGY: ${entry.label}`,
    path: join(config.subAgents.strategiesPath, entry.file),
    maxChars: entry.maxChars,
  }));

  // Skill definitions — sorted alphabetically
  const skillSections: string[] = [];
  const skillsDir = join(ws, "skills");
  try {
    const skillEntries = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of skillEntries) {
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      const content = await loadFileOrNull(skillPath);
      if (content) {
        skillSections.push(`## SKILL: ${entry.name}\n${truncate(content.trim(), 2000)}`);
      }
    }
  } catch {
    // No skills directory
  }

  const sections: string[] = [];
  for (const { label, path, maxChars } of [...coreFiles, ...strategyFiles]) {
    const content = await loadFileOrNull(path);
    if (content) {
      sections.push(`## ${label}\n${truncate(content.trim(), maxChars)}`);
    }
  }
  sections.push(...skillSections);

  return sections.join("\n\n");
}

/**
 * Load the 3-tier memory index and referenced topic files.
 *
 * Tier 1: INDEX.md (always loaded, max 5000 chars)
 * Tier 2: topic files referenced via `- [Title](topics/filename.md)` (max 5 files, 3000 chars each)
 * Tier 3: raw logs (grep only — not loaded here)
 */
async function loadMemoryIndex(ws: string): Promise<string[]> {
  const sections: string[] = [];

  // Tier 1: INDEX.md
  const indexPath = join(ws, "memory", "INDEX.md");
  const indexContent = await loadFileOrNull(indexPath);
  if (!indexContent) return sections;
  sections.push(`## MEMORY INDEX\n${truncate(indexContent.trim(), 5000)}`);

  // Tier 2: parse topic references and load them
  const topicPattern = /^- \[([^\]]+)\]\(topics\/([^)]+\.md)\)/gm;
  let match: RegExpExecArray | null;
  let topicCount = 0;
  const MAX_TOPICS = 5;
  const MAX_TOPIC_CHARS = 3000;

  while ((match = topicPattern.exec(indexContent)) !== null && topicCount < MAX_TOPICS) {
    const title = match[1]!;
    const filename = match[2]!;
    const topicPath = join(ws, "memory", "topics", filename);
    const topicContent = await loadFileOrNull(topicPath);
    if (topicContent) {
      sections.push(`## MEMORY TOPIC: ${title}\n${truncate(topicContent.trim(), MAX_TOPIC_CHARS)}`);
      topicCount++;
    }
  }

  return sections;
}

/**
 * Build the DYNAMIC portion of the system prompt.
 * This content changes every turn: daily logs, handoff, conversation history,
 * weekly/monthly summaries, memory index/topics, and runtime context.
 */
async function buildDynamicPrompt(
  channelId: string,
  senderName: string,
  taskType: TaskType,
): Promise<{ content: string; dynamicSections: string[] }> {
  const ws = config.workspace;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dynamicFiles: FileSpec[] = [
    {
      label: `DAILY (${formatDate(today)})`,
      path: join(ws, "memory", "daily", `${formatDate(today)}.md`),
      maxChars: 8000,
      truncateFrom: "tail",
    },
    {
      label: `DAILY (${formatDate(yesterday)})`,
      path: join(ws, "memory", "daily", `${formatDate(yesterday)}.md`),
      maxChars: 4000,
      truncateFrom: "tail",
    },
    {
      label: "HANDOFF",
      path: join(ws, "HANDOFF.md"),
      maxChars: 5000,
      deleteAfterLoad: true,
    },
  ];

  const sections: string[] = [];
  for (const { label, path, maxChars, deleteAfterLoad, truncateFrom } of dynamicFiles) {
    const content = await loadFileOrNull(path);
    if (content) {
      sections.push(`## ${label}\n${truncate(content.trim(), maxChars, truncateFrom)}`);
      if (deleteAfterLoad) {
        try { await unlink(path); } catch { /* ignore */ }
      }
    }
  }

  // Weekly/monthly summaries
  const weeklyDir = join(ws, "memory", "weekly");
  const monthlyDir = join(ws, "memory", "monthly");

  const recentWeekly = await findMostRecent(weeklyDir);
  if (recentWeekly) {
    sections.push(`## WEEKLY SUMMARY (latest)\n${truncate(recentWeekly.trim(), 4000)}`);
  }

  const recentMonthly = await findMostRecent(monthlyDir);
  if (recentMonthly) {
    sections.push(`## MONTHLY SUMMARY (latest)\n${truncate(recentMonthly.trim(), 3000)}`);
  }

  // 3-tier memory: INDEX.md + topic files
  const memorySections = await loadMemoryIndex(ws);
  sections.push(...memorySections);

  const channelConfig = resolveChannelConfig(channelId);
  const isRestricted = channelConfig.accessLevel === "general";

  // Conversation history (from this channel's chatId)
  const conversationHistory = await fetchRecentMessages(channelConfig.chatId);

  // Runtime context — varies by channel access level
  const phone = channelConfig.phone;
  const toolsPath = config.subAgents.toolsPath;

  let runtimeContext: string;

  if (isRestricted) {
    runtimeContext = `<runtime_context>
Time: ${formatTimePT(today)}
Channel: iMessage from ${senderName} (${phone})
You are Youngsu. Read the persona file loaded in the static prompt for your behavior with this user.
Session type: GENERAL — general help only. No coding, trading, or file management.
You have Bash tool — use it to call: imsg, weather via wttr.in, WebSearch, WebFetch

Message delivery: The daemon auto-sends your text response as an iMessage. Do NOT also send it yourself via "imsg send" — that causes duplicates.

Access restrictions for this channel:
- NO stock trading, portfolio queries, or financial operations
- NO code writing, debugging, PR management, or git operations
- NO system file access or modification
- NO sharing June's private work information
- If asked about restricted topics, politely redirect: "준한테 직접 물어봐!"
</runtime_context>`;
  } else {
    const sessionType = taskType;
    const taskRoleMap: Record<TaskType, string> = {
      coding: `Session type: CODING — Apply Youngsik (Frontend) and Youngchul (Backend) engineering principles.
Focus: implementation quality, type safety, testing, code review standards.
Available on-demand (read strategy file before delegating): Junho (QA), Taeyoung (DevOps), Youngho (Design).`,
      research: `Session type: RESEARCH — Apply Kwangsoo (Strategy) and Sangchul (Marketing) analysis principles.
Focus: evidence-based analysis, source hierarchy (S-Tier > A-Tier), market sizing, competitive intelligence.
Available on-demand: Kwangsoo for deep financial/trading analysis.`,
      general: `Session type: GENERAL — You are the orchestrator (PM/Director).
Focus: planning, coordination, delegation, product decisions, user communication.
Delegate to sub-agents when specialized work is needed.`,
      quick: `Session type: QUICK — Concise response only.`,
    };

    runtimeContext = `<runtime_context>
Time: ${formatTimePT(today)}
Channel: iMessage from ${senderName} (${phone})
You are Youngsu. Respond in the style defined in SOUL.md.
${taskRoleMap[sessionType]}
You have Bash tool — use it to call: imsg, gh, memo, remindctl, things, weather via wttr.in

Message delivery: The daemon auto-sends your text response as an iMessage. Do NOT also send it yourself via "imsg send" — that causes duplicates. Only use "imsg send" for PROACTIVE messages (alerts, news, broadcasts to other recipients) that are separate from your reply to the current message.

Sub-agent delegation (use Agent tool):
- Read strategies/dev-team-{name}.md for each sub-agent's role-specific prompt before delegating
- Agent lifecycle: Bash("${toolsPath}/agent-lifecycle.sh register|complete|cascade-kill|status|orphans|archive")
- Agent mailbox: Bash("${toolsPath}/mailbox.sh send|read|peek|broadcast|list")
- Max concurrent sub-agents: ${config.subAgents.maxConcurrent}

Send iMessage (proactive only): Bash("imsg send --to ${phone} --text \\"...\\"")
</runtime_context>`;
  }

  const parts = sections;
  if (conversationHistory) {
    parts.push(conversationHistory);
  }
  parts.push(runtimeContext);

  return { content: parts.join("\n\n"), dynamicSections: sections };
}

// ── Public API ──────────────────────────────────────────────

export interface SystemPromptResult {
  /** Full system prompt (static + dynamic) */
  prompt: string;
  /** Static portion — cache this across calls with same taskType */
  staticPrompt: string;
  /** Dynamic portion — changes every turn */
  dynamicPrompt: string;
  /** Hash of static prompt — use to detect when cache should be invalidated */
  staticHash: string;
}

export async function buildSystemPrompt(
  channelId: string,
  senderName: string,
  taskType?: TaskType,
): Promise<string> {
  const result = await buildSystemPromptSplit(channelId, senderName, taskType);
  return result.prompt;
}

export async function buildSystemPromptSplit(
  channelId: string,
  senderName: string,
  taskType?: TaskType,
): Promise<SystemPromptResult> {
  const tt = taskType ?? "general";
  const cacheKey = `${channelId}/${tt}`;

  // Build static prompt (check cache first)
  let staticContent = await buildStaticPrompt(tt, channelId);
  const currentHash = hashContent(staticContent);

  const cached = staticCache.get(cacheKey);
  if (cached && cached.hash === currentHash) {
    staticContent = cached.content; // byte-identical for API cache
  } else {
    staticCache.set(cacheKey, { hash: currentHash, content: staticContent });
  }

  // Build dynamic prompt (always fresh)
  const { content: dynamicContent, dynamicSections } = await buildDynamicPrompt(
    channelId, senderName, tt,
  );

  // Assemble: STATIC first (cacheable prefix) then DYNAMIC
  const staticWrapped = `<workspace_context>\n${staticContent}`;
  const dynamicWrapped = `${dynamicContent}\n</workspace_context>`;
  const prompt = `${staticWrapped}\n\n__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__\n\n${dynamicWrapped}`;

  // Diagnostic logging
  const taskLabel = tt;
  console.log(
    `[loader] ${channelId}/${taskLabel} total=${prompt.length} static=${staticContent.length} dynamic=${dynamicContent.length} cache=${cached?.hash === currentHash ? "HIT" : "MISS"}`,
  );

  const PROMPT_WARN_THRESHOLD = 100_000;
  if (prompt.length > PROMPT_WARN_THRESHOLD) {
    console.warn(
      `[loader] system prompt is ${prompt.length} chars (threshold: ${PROMPT_WARN_THRESHOLD})`,
    );
  }

  return {
    prompt,
    staticPrompt: staticWrapped,
    dynamicPrompt: dynamicWrapped,
    staticHash: currentHash,
  };
}
