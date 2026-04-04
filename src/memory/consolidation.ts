import { readFile, readdir, writeFile, appendFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { runClaude } from "../agent/runner.js";
import { appendSystemLog } from "./writer.js";

const memoryDir = join(config.workspace, "memory");
const dailyDir = join(memoryDir, "daily");
const weeklyDir = join(memoryDir, "weekly");
const monthlyDir = join(memoryDir, "monthly");
const lessonsDir = join(memoryDir, "lessons");

async function loadFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function getISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86_400_000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7,
    );
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

export async function runLessonsLoop(): Promise<void> {
  const today = new Date().toISOString().split("T")[0]!;
  const dailyPath = join(dailyDir, `${today}.md`);
  const dailyContent = await loadFileOrNull(dailyPath);

  if (!dailyContent || dailyContent.trim().length < 50) {
    return; // Nothing meaningful to extract lessons from
  }

  // Extract lessons
  const lessonsPrompt = `You are reviewing today's daily log to extract lessons learned.
Read the daily log and produce a structured lessons file:

# Daily Lessons - ${today}
## Problems Encountered
## Root Causes
## Solutions Applied
## Preventative Rules (new rules to prevent recurrence)

If there were no notable problems/lessons today, write a brief "No significant issues" note.
Keep it concise — focus on actionable patterns, not conversation summaries.`;

  const lessonsResult = await runClaude({
    prompt: dailyContent,
    systemPrompt: lessonsPrompt,
  });

  await mkdir(lessonsDir, { recursive: true });
  const lessonsPath = join(lessonsDir, `${today}-lessons.md`);
  await writeFile(lessonsPath, lessonsResult.response, "utf-8");

  // Update master-rules
  const masterRulesPath = join(lessonsDir, "master-rules.md");
  const masterRules = (await loadFileOrNull(masterRulesPath)) ?? "";

  const rulesPrompt = `You are updating master-rules.md with new preventative rules from today's lessons.
If any new preventative rules should be added:
- Check if a similar rule already exists; if so, do NOT duplicate
- Add new rules in format: "RULE-XXX: [trigger] → [instruction]. Reason: [why]"
- Respond with ONLY the new rules to append (one per line), or exactly "NO_NEW_RULES" if none needed.`;

  const rulesResult = await runClaude({
    prompt: `Current master-rules:\n${masterRules.slice(-5000)}\n\nToday's lessons:\n${lessonsResult.response}`,
    systemPrompt: rulesPrompt,
  });

  if (
    !rulesResult.response.includes("NO_NEW_RULES") &&
    rulesResult.response.trim().length > 0
  ) {
    await appendFile(masterRulesPath, `\n${rulesResult.response.trim()}\n`, "utf-8");
  }

  await appendSystemLog(`Lessons loop completed for ${today}`);
}

export async function runWeeklyCompression(): Promise<void> {
  await mkdir(weeklyDir, { recursive: true });

  let files: string[];
  try {
    files = (await readdir(dailyDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return;
  }

  if (files.length < 7) return;

  // Group by ISO week
  const weeks = new Map<string, string[]>();
  for (const f of files) {
    const dateStr = f.replace(".md", "");
    const date = new Date(dateStr + "T12:00:00Z");
    if (isNaN(date.getTime())) continue;
    const week = getISOWeek(date);
    const arr = weeks.get(week) ?? [];
    arr.push(f);
    weeks.set(week, arr);
  }

  // Only compress completed weeks (7 files) that aren't the current week
  const currentWeek = getISOWeek(new Date());

  for (const [week, weekFiles] of weeks) {
    if (week === currentWeek) continue;
    if (weekFiles.length < 5) continue; // Allow 5+ for partial weeks

    const weeklyPath = join(weeklyDir, `${week}.md`);
    if (await loadFileOrNull(weeklyPath)) continue; // Already compressed

    // Load all daily files for this week
    const contents: string[] = [];
    for (const f of weekFiles.sort()) {
      const content = await loadFileOrNull(join(dailyDir, f));
      if (content) contents.push(`### ${f.replace(".md", "")}\n${content}`);
    }

    const compressionPrompt = `You are compressing daily logs into a weekly summary.
Produce a structured weekly summary:

# Weekly Summary — ${week}
## Key Events & Decisions
## Work Completed
## Issues & Resolutions
## Patterns & Trends
## Carry-Forward Items

Be concise. Preserve important decisions and context. Drop routine conversation.`;

    const result = await runClaude({
      prompt: contents.join("\n\n---\n\n"),
      systemPrompt: compressionPrompt,
    });

    await writeFile(weeklyPath, result.response, "utf-8");

    // Delete compressed daily files
    for (const f of weekFiles) {
      await unlink(join(dailyDir, f)).catch(() => {});
    }

    await appendSystemLog(
      `Weekly compression: ${week} (${weekFiles.length} daily files → ${weeklyPath})`,
    );
  }
}

export async function runMonthlyCompression(): Promise<void> {
  await mkdir(monthlyDir, { recursive: true });

  let files: string[];
  try {
    files = (await readdir(weeklyDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return;
  }

  if (files.length < 4) return;

  // Group by month using the Thursday of each ISO week
  const months = new Map<string, string[]>();
  for (const f of files) {
    const weekStr = f.replace(".md", "");
    const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
    if (!match) continue;
    const year = parseInt(match[1]!);
    const weekNum = parseInt(match[2]!);
    // Find Thursday of ISO week: Jan 4 is always in week 1,
    // find its Monday, then add (weekNum - 1) weeks + 3 days (Thursday)
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1..Sun=7
    const week1Monday = new Date(jan4.getTime() - (dayOfWeek - 1) * 86_400_000);
    const thursday = new Date(week1Monday.getTime() + ((weekNum - 1) * 7 + 3) * 86_400_000);
    const month = `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, "0")}`;
    const arr = months.get(month) ?? [];
    arr.push(f);
    months.set(month, arr);
  }

  const currentMonth = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  })();

  for (const [month, monthFiles] of months) {
    if (month === currentMonth) continue;
    if (monthFiles.length < 3) continue;

    const monthlyPath = join(monthlyDir, `${month}.md`);
    if (await loadFileOrNull(monthlyPath)) continue;

    const contents: string[] = [];
    for (const f of monthFiles.sort()) {
      const content = await loadFileOrNull(join(weeklyDir, f));
      if (content) contents.push(`### ${f.replace(".md", "")}\n${content}`);
    }

    const compressionPrompt = `You are aggregating weekly summaries into a monthly overview.
Produce:

# Monthly Summary — ${month}
## Major Accomplishments
## Key Decisions & Their Outcomes
## Recurring Patterns
## Strategic Insights
## Open Items Carried Forward

Be high-level. This is long-term memory — preserve only what matters months from now.`;

    const result = await runClaude({
      prompt: contents.join("\n\n---\n\n"),
      systemPrompt: compressionPrompt,
    });

    await writeFile(monthlyPath, result.response, "utf-8");

    // Delete compressed weekly files
    for (const f of monthFiles) {
      await unlink(join(weeklyDir, f)).catch(() => {});
    }

    await appendSystemLog(
      `Monthly compression: ${month} (${monthFiles.length} weekly files → ${monthlyPath})`,
    );
  }
}
