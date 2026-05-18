/**
 * iMessage-driven /login recovery.
 *
 * Flow:
 *   1. /relogin           → spawn `claude` in tmux, send /login, capture OAuth URL, reply.
 *   2. user texts code    → paste into the same tmux session, capture pane, confirm.
 *   3. user texts /cancel → kill session, clear state.
 *
 * State (one in-flight session per phone, 5-min TTL) lives in-memory; daemon
 * restart cancels. Only one phone can recover at a time — the tmux session
 * name is shared because allowing concurrent recoveries would let phone B's
 * spawned claude receive phone A's OAuth code (session hijack).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

const TMUX_SESSION = "auth-recovery";
const STATE_TTL_MS = 5 * 60_000;

/**
 * Tunable timings. Defaults assume `claude` CLI startup + OAuth code exchange
 * complete within these windows. Override via env for flaky machines.
 */
const TIMINGS = {
  /** Delay between `tmux new-session` and `/login` keystroke (claude startup). */
  claudeStartMs: 2500,
  /** Per-attempt poll wait when scraping the pane for the OAuth URL. */
  urlPollIntervalMs: 2000,
  /** How many poll attempts before giving up on URL extraction. */
  urlPollAttempts: 4,
  /** Wait after pasting OAuth code, before reading pane for success/failure. */
  codeExchangeMs: 5000,
};

/**
 * Match the OAuth URL claude CLI prints. Requires `/oauth/` (or `/cai/oauth/`)
 * path segment to filter doc/marketing URLs in startup banners.
 *
 * Observed hostnames (across CLI versions): anthropic.com, claude.ai,
 * claude.com. We accept all three.
 *
 * Terminal wrap is a real problem — even with `tmux capture-pane -J`, long
 * URLs that hit ~80-col wrap arrive with literal newlines/spaces in the
 * middle. `extractOauthUrl()` strips whitespace from the candidate region
 * before matching.
 */
const URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)?(?:anthropic\.com|claude\.ai|claude\.com)\/(?:cai\/)?oauth\/[^\s)>"]+/i;

/** Pattern signalling the URL is somewhere on screen, even if line-wrapped. */
const URL_HOSTNAME_RE = /https?:\/\/(?:[a-z0-9-]+\.)?(?:anthropic\.com|claude\.ai|claude\.com)/i;

/**
 * First-run wizard screens that need Enter to advance. Observed sequence:
 *   1. "Quick safety check" — trust this folder
 *   2. Theme picker (Dark / Light / etc.)
 *   3. "Select login method" — Claude subscription / Anthropic Console / 3rd
 * Order is not stable across CLI versions, so the state machine just
 * matches whichever one is currently on screen.
 */
const WIZARD_SCREEN_RE = /Quick safety check|Is this a project you|trust this folder|Syntax theme|Light mode \(ANSI|Dark mode|Select login method|Claude account with subscription/i;

/** Main interactive prompt is ready (creds were already valid). */
const MAIN_PROMPT_RE = /Try ".+"|auto mode on|shift\+tab to cycle/i;

/**
 * Definitive success markers — printed after a fresh OAuth code is accepted.
 * Observed in claude CLI v2.1:
 *   "Login successful. Press Enter to continue…"
 *   "Logged in as <email>"
 * Both appear together on the success screen; matching either is reliable
 * (we wipe the tmux session immediately after, so leftover-line false
 * positives can't occur on the next /relogin).
 */
const SUCCESS_RE = /Logged in successfully|Authentication successful|login complete|setup complete|Login successful\.\s*Press Enter|Logged in as \S+@\S+/i;

const FAILURE_RE = /Invalid code|code expired|authentication failed|access denied/i;

interface ReloginState {
  startedAt: number;
  expiresAt: number;
}

const states = new Map<string, ReloginState>();

export function isAwaitingCode(phone: string): boolean {
  const s = states.get(phone);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    states.delete(phone);
    return false;
  }
  return true;
}

/** Returns the phone that currently has an in-flight recovery, or null. */
function getActiveOtherPhone(excludePhone: string): string | null {
  for (const [phone, s] of states) {
    if (phone === excludePhone) continue;
    if (Date.now() > s.expiresAt) {
      states.delete(phone);
      continue;
    }
    return phone;
  }
  return null;
}

function setState(phone: string): void {
  const now = Date.now();
  states.set(phone, { startedAt: now, expiresAt: now + STATE_TTL_MS });
}

function clearState(phone: string): void {
  states.delete(phone);
}

async function tmuxKill(): Promise<void> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", TMUX_SESSION]);
  } catch {
    // session may not exist
  }
}

async function tmuxCapture(): Promise<string> {
  try {
    // `-J` joins wrapped lines so a long OAuth URL doesn't split across rows
    // and break URL_RE. `-S -100` includes 100 lines of scrollback.
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane", "-t", TMUX_SESSION, "-p", "-J", "-S", "-100",
    ]);
    return stdout;
  } catch {
    return "";
  }
}

/**
 * Send a literal string then Enter as separate commands. The `-l` flag tells
 * tmux to treat keys as literal characters, so an OAuth code that happens to
 * contain tokens like "Enter" / "Tab" / "C-c" can't be interpreted as key
 * events.
 */
async function tmuxPasteThenEnter(text: string): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", TMUX_SESSION, "-l", text]);
  await execFileAsync("tmux", ["send-keys", "-t", TMUX_SESSION, "Enter"]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull the OAuth URL out of a captured pane.
 *
 * Wrap handling: even with `tmux capture-pane -J`, long URLs frequently
 * arrive split by literal newlines + leading whitespace. A "direct" regex
 * match would only grab the first segment before the break. So we always
 * locate the hostname, take a generous tail (OAuth URLs are <1KB), strip
 * whitespace, and match against the strict URL pattern.
 */
function extractOauthUrl(pane: string): string | null {
  const hostHit = pane.match(URL_HOSTNAME_RE);
  if (!hostHit || hostHit.index == null) return null;
  const tail = pane.slice(hostHit.index, hostHit.index + 2000);
  const collapsed = tail.replace(/\s+/g, "");
  const m = collapsed.match(URL_RE);
  return m ? m[0] : null;
}

/**
 * Drive the spawned `claude` TUI through whatever sequence of wizard
 * screens it shows until either an OAuth URL appears or we give up.
 *
 * Policy: every spawn forces a fresh OAuth round (token refresh) rather
 * than short-circuiting on "already logged in". This is intentional — if
 * the user typed /relogin, they want a new token, not a courtesy ack.
 *
 * Loop state machine:
 *   - URL on screen          → return URL (done)
 *   - wizard screen          → press Enter, re-poll
 *   - main prompt, no URL    → type /login, re-poll
 *   - nothing recognized     → keep polling until budget exhausted
 */
async function driveLoginWizard(maxStepMs = 30_000): Promise<{
  url: string | null;
  lastPane: string;
}> {
  const overallDeadline = Date.now() + maxStepMs;
  let loginSent = false;
  let lastPane = "";

  // Initial wait for claude TUI to render anything.
  await sleep(TIMINGS.claudeStartMs);

  while (Date.now() < overallDeadline) {
    lastPane = await tmuxCapture();

    // Highest priority: URL on screen — done.
    const url = extractOauthUrl(lastPane);
    if (url) return { url, lastPane };

    // Wizard screen detected (trust / theme / login-method) → press Enter
    // to accept default and advance.
    if (WIZARD_SCREEN_RE.test(lastPane)) {
      await execFileAsync("tmux", ["send-keys", "-t", TMUX_SESSION, "Enter"]);
      await sleep(TIMINGS.urlPollIntervalMs);
      continue;
    }

    // Main prompt reached without seeing wizard screens (creds already
    // valid). Send /login once to force the OAuth flow.
    if (MAIN_PROMPT_RE.test(lastPane) && !loginSent) {
      await tmuxPasteThenEnter("/login");
      loginSent = true;
      await sleep(TIMINGS.urlPollIntervalMs);
      continue;
    }

    // Unknown screen — keep polling. Possible causes: claude still
    // rendering, or first frame hasn't drawn yet.
    await sleep(TIMINGS.urlPollIntervalMs);
  }

  return { url: null, lastPane };
}

export async function startRelogin(phone: string): Promise<string> {
  // Reject if another phone is mid-recovery — concurrent sessions would let
  // their codes cross-paste into the wrong claude process.
  const other = getActiveOtherPhone(phone);
  if (other) {
    return `❌ 다른 사용자 (${other}) 의 /relogin 진행 중. 완료/만료 후 재시도.`;
  }

  await tmuxKill();
  try {
    await execFileAsync("tmux", [
      "new-session", "-d", "-s", TMUX_SESSION,
      "-c", config.projectDir,
      "claude",
    ]);
  } catch (err) {
    return `❌ tmux 세션 생성 실패: ${err instanceof Error ? err.message : String(err)}`;
  }

  const { url, lastPane } = await driveLoginWizard();

  if (!url) {
    await tmuxKill();
    return [
      "❌ OAuth URL 추출 실패.",
      "다음 시도 시 daemon 로그 확인: ~/.juneclaw/logs/daemon.log",
      "",
      "마지막 화면 (디버그):",
      lastPane.slice(-600) || "(empty)",
    ].join("\n");
  }

  setState(phone);
  return [
    "🔑 /login 시작",
    "",
    "1) 폰 브라우저로 URL 열기",
    "2) 로그인 후 받은 코드를 그대로 회신",
    "3) 5분 내 미회신 시 자동 만료",
    "4) 취소하려면 /cancel",
    "",
    url,
  ].join("\n");
}

export async function submitCode(phone: string, code: string): Promise<string> {
  if (!isAwaitingCode(phone)) {
    return "진행 중인 /relogin 세션 없음";
  }

  try {
    await tmuxPasteThenEnter(code.trim());
  } catch (err) {
    clearState(phone);
    await tmuxKill();
    return `❌ paste 실패 (세션 죽었음): ${err instanceof Error ? err.message : String(err)}`;
  }

  await sleep(TIMINGS.codeExchangeMs);
  const pane = await tmuxCapture();
  clearState(phone);
  await tmuxKill();

  if (SUCCESS_RE.test(pane)) {
    return "✅ /login 완료. 다음 호출부터 정상 동작";
  }
  if (FAILURE_RE.test(pane)) {
    return [
      "❌ 코드 거부됨. /relogin 으로 새 URL 받아 다시 시도.",
      "",
      "마지막 화면:",
      pane.slice(-400),
    ].join("\n");
  }
  return [
    "⚠️ 결과 불명확 — 직접 확인 필요.",
    "",
    "마지막 화면:",
    pane.slice(-500),
  ].join("\n");
}

/**
 * Idempotent: returns a different message when no session is active so /cancel
 * can be safely routed for every phone without side-effects.
 */
export async function cancelRelogin(phone: string): Promise<string> {
  if (!isAwaitingCode(phone)) {
    return "진행 중인 /relogin 세션 없음";
  }
  clearState(phone);
  await tmuxKill();
  return "🛑 /relogin 취소됨";
}

// ── Auth-failure alert (one-way) ───────────────────────────────────────────

const ALERT_COOLDOWN_MS = 30 * 60_000;
let lastAlertAt = 0;

/**
 * Best-effort iMessage alert when daemon detects 401/auth failure.
 *
 * Single-recipient by design — only June (full-access owner) receives this.
 * Other channels (e.g. 햄톨) don't own the auth token and can't recover it.
 *
 * Dedups to one message per 30 min so a retry storm doesn't spam.
 * Independent of Claude — uses `imsg` CLI directly so it still works while
 * Claude itself is failing.
 */
export async function reportAuthFailure(): Promise<void> {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;

  const msg = [
    "🚨 Claude 인증 만료 (401 / socket closed)",
    "",
    "복구: \"/relogin\" 회신 → 새 /login URL 받아 진행.",
  ].join("\n");

  try {
    await execFileAsync("imsg", [
      "send", "--to", config.channels.june.phone, "--text", msg,
    ]);
  } catch {
    // best-effort
  }
}

// ── Test-only helpers ──────────────────────────────────────────────────────

/** Reset all module state. Test-only. */
export function _resetForTests(): void {
  states.clear();
  lastAlertAt = 0;
}
