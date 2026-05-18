/**
 * iMessage-driven /login recovery.
 *
 * Flow:
 *   1. /relogin     → spawn `claude` in tmux, send /login, capture OAuth URL, reply.
 *   2. user texts code → paste into the same tmux session, capture pane, confirm.
 *
 * State (one in-flight session per phone, 5-min TTL) lives in-memory; daemon
 * restart cancels. Tmux session name is shared because we only support one
 * concurrent recovery — simpler than tracking per-phone sessions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

const TMUX_SESSION = "auth-recovery";
const STATE_TTL_MS = 5 * 60_000;

const URL_RE = /https?:\/\/[^\s)>"]*anthropic[^\s)>"]*/i;
const SUCCESS_RE = /Logged in|successfully|success|login complete|✓/i;
const FAILURE_RE = /Invalid|expired|error|denied|failed/i;

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
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane", "-t", TMUX_SESSION, "-p", "-S", "-100",
    ]);
    return stdout;
  } catch {
    return "";
  }
}

async function tmuxSendKeys(keys: string): Promise<void> {
  await execFileAsync("tmux", ["send-keys", "-t", TMUX_SESSION, keys, "Enter"]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startRelogin(phone: string): Promise<string> {
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

  // Wait for claude to render its prompt.
  await sleep(2500);
  try {
    await tmuxSendKeys("/login");
  } catch (err) {
    await tmuxKill();
    return `❌ /login 전송 실패: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Poll up to ~8s for URL to appear in pane.
  let url: string | undefined;
  let lastPane = "";
  for (let i = 0; i < 4; i++) {
    await sleep(2000);
    lastPane = await tmuxCapture();
    const m = lastPane.match(URL_RE);
    if (m) { url = m[0]; break; }
  }

  if (!url) {
    await tmuxKill();
    return [
      "❌ /login URL 추출 실패.",
      "마지막 화면 (디버그):",
      lastPane.slice(-400) || "(empty)",
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
    await tmuxSendKeys(code.trim());
  } catch (err) {
    clearState(phone);
    await tmuxKill();
    return `❌ paste 실패 (세션 죽었음): ${err instanceof Error ? err.message : String(err)}`;
  }

  // Wait for OAuth exchange to complete.
  await sleep(5000);
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
 * Deduped to one message per 30 min so retries don't spam.
 * Independent of Claude — uses `imsg` CLI directly.
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
