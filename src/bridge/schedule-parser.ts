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

const SCHEDULE_BLOCK = /\[\[SCHEDULE\s*\n([\s\S]*?)\n\]\]/g;

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

const FETCH_TIMEOUT_MS = 5_000;

export interface ForwardResult {
  ok: number;
  failed: number;
  failures: Array<{ phone: string; fireAt: string; reason: string }>;
}

/**
 * POST scheduled reminders to Hustle API.
 *
 * Non-fatal: returns a structured result instead of throwing. Callers can
 * surface failures to the user — the prior silent-warn-only behavior
 * masked missed reminders.
 */
export async function forwardSchedules(
  blocks: ScheduleBlock[],
  opts: { sourcePhone?: string; agentTaskType?: string } = {},
): Promise<ForwardResult> {
  const result: ForwardResult = { ok: 0, failed: 0, failures: [] };
  if (blocks.length === 0) return result;
  if (!HUSTLE_TEAM_ID) {
    console.warn("[schedule] HUSTLE_DEFAULT_TEAM_ID not set — cannot persist reminders");
    result.failed = blocks.length;
    for (const b of blocks) {
      result.failures.push({ phone: b.phone, fireAt: b.fireAt, reason: "HUSTLE_DEFAULT_TEAM_ID not configured" });
    }
    return result;
  }

  for (const block of blocks) {
    const reason = await postReminder(block);
    if (reason === null) {
      result.ok++;
      console.log(`[schedule] ✓ queued reminder to ${maskPhone(block.phone)} at ${block.fireAt}`);
    } else {
      result.failed++;
      result.failures.push({ phone: block.phone, fireAt: block.fireAt, reason });
      console.warn(`[schedule] ✗ ${maskPhone(block.phone)} @ ${block.fireAt}: ${reason}`);
    }
  }

  if (result.failed > 0) {
    console.warn(`[schedule] forwardSchedules summary: ${result.ok} queued, ${result.failed} FAILED (see above)`);
  }

  return result;
}

async function postReminder(block: ScheduleBlock): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (HUSTLE_INTERNAL_KEY) headers["X-Internal-Key"] = HUSTLE_INTERNAL_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
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
      signal: controller.signal,
    });
    if (res.ok) return null;
    const body = await res.text().catch(() => "");
    return `HTTP ${res.status} ${body.slice(0, 120)}`;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return `timeout after ${FETCH_TIMEOUT_MS}ms`;
    }
    return err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 8) return "***";
  return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
}
