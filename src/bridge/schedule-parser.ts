/**
 * Parse [[SCHEDULE ...]] blocks from agent responses and forward to Hustle.
 * Failures are non-fatal and silent — agent text is still sent to user.
 */
const HUSTLE_URL = process.env.HUSTLE_URL || "http://127.0.0.1:3100";
const HUSTLE_TEAM_ID = process.env.HUSTLE_DEFAULT_TEAM_ID;
const HUSTLE_INTERNAL_KEY = process.env.HUSTLE_INTERNAL_KEY;

export interface ScheduleBlock {
  phone: string;
  fireAt: string; // ISO-8601
  message: string;
}

// Tolerant of trailing whitespace before `]]` and optional preceding newline,
// since agents occasionally emit `...message: foo]]` on one line or trail spaces.
const SCHEDULE_BLOCK = /\[\[SCHEDULE\s*\n([\s\S]*?)\s*\]\]/g;

export function parseScheduleBlocks(text: string): ScheduleBlock[] {
  const blocks: ScheduleBlock[] = [];
  for (const match of text.matchAll(SCHEDULE_BLOCK)) {
    const body = match[1];
    const fields: Record<string, string> = {};
    let currentKey: string | null = null;
    let currentValue: string[] = [];

    for (const line of body.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) {
        if (currentKey) fields[currentKey] = currentValue.join("\n").trim();
        currentKey = m[1];
        currentValue = [m[2]];
      } else if (currentKey) {
        currentValue.push(line);
      }
    }
    if (currentKey) fields[currentKey] = currentValue.join("\n").trim();

    if (fields.phone && fields.at && fields.message) {
      blocks.push({ phone: fields.phone, fireAt: fields.at, message: fields.message });
    }
  }
  return blocks;
}

/**
 * Strip SCHEDULE blocks from text (so user doesn't see them in the message).
 */
export function stripScheduleBlocks(text: string): string {
  return text.replace(SCHEDULE_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * POST scheduled reminders to Hustle API. Silent on failure.
 */
export async function forwardSchedules(
  blocks: ScheduleBlock[],
  opts: { sourcePhone?: string; agentTaskType?: string } = {},
): Promise<{ ok: number; failed: number }> {
  if (blocks.length === 0) return { ok: 0, failed: 0 };
  if (!HUSTLE_TEAM_ID) {
    console.warn("[schedule] HUSTLE_DEFAULT_TEAM_ID not set — cannot persist reminders");
    return { ok: 0, failed: blocks.length };
  }

  let ok = 0;
  let failed = 0;

  for (const block of blocks) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (HUSTLE_INTERNAL_KEY) headers["X-Internal-Key"] = HUSTLE_INTERNAL_KEY;

      const res = await fetch(`${HUSTLE_URL}/api/internal/reminders`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          teamId: HUSTLE_TEAM_ID,
          phone: block.phone,
          message: block.message,
          fireAt: block.fireAt,
          source: "agent",
        }),
      });
      if (res.ok) {
        ok++;
        console.log(`[schedule] ✓ queued reminder to ${block.phone} at ${block.fireAt}`);
      } else {
        failed++;
        const body = await res.text().catch(() => "");
        console.warn(`[schedule] ✗ Hustle rejected: ${res.status} ${body.slice(0, 120)}`);
      }
    } catch (err) {
      failed++;
      console.warn(`[schedule] ✗ forward failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { ok, failed };
}
