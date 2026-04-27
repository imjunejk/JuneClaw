import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { runClaude, type RunResult } from "../agent/runner.js";

// ── System Context (항상 핸드오프에 포함) ──────────────────
const SYSTEM_CONTEXT = `
## System Context (광수 트레이딩 시스템)
사륙 V8 = 동적 5단계 Inverse Safety. SoT: \`gwangsu/algo/strategies/portfolio_manager.py:62-77\` SEPA_WEIGHT_BY_DAYS.
백테스트 베이스라인 (174종목): CAGR 38.9% | Sharpe 1.452 | MDD -30.6%

QQQ 200SMA 연속 상회일수 기반 비중 자동 조절:
- 10일+ → AgiTQ 15% / SEPA 85% (FULL_BULL, 공격)
- 5일+  → AgiTQ 20% / SEPA 80% (BULL_STRONG)
- 3일+  → AgiTQ 30% / SEPA 70% (BULL_WEAK)
- 2일+  → AgiTQ 40% / SEPA 60% (CAUTION)
- 1일/BEAR → AgiTQ 50% / SEPA 50% (EARLY/BEAR, SGOV 피난)
폴백: AgiTQ 20% / SEPA 80%. 드리프트 5%p 초과 시 월요일 리밸런싱.

- AgiTQ: TQQQ 200SMA 2일확인 + BTC 200SMA 필터 + VIX 필터 (25 사이즈 50%, 35 즉시 퇴출), 익절 20%
- SEPA V8: TT 8/8 + 6가지 개선 통합
  1) 점수가중 포지션 사이징 (핵심 혁신, +32% CAGR)
  2) 섹터 분산 (max 2/섹터, 반도체 별도 버킷)
  3) 품질필터 (일평균 거래대금 $50M+, 52주 고점 -25% 이내)
  4) Chandelier Stop (고점 대비 -15%)
  5) Profit Ratchet (+25% BE, +50% 이익 50% 락인)
  6) TT 7+ 허용 (SEPA BREAKOUT 신호 있을 때만)
  + -10% 하드 스탑
- 리스크: 서킷브레이커 (WARN -5% / HALT -7% / EMERG -10%, 마진<1.10/1.05/1.02)
- 매매는 portfolio_manager.py가 통합 관리 (유일한 매매 주체)
- 크론 (PT): 월 06:20 리밸런싱 | 06:15 sepa_radar scan | 06:31 sepa-scan 알림 |
  12:50 check | 12:55 sepa-check (리밋) | 12:57 AgiTQ execute | 12:58 sepa-execute (market 전환) | 13:02 agitq-followup
- Alpaca 라이브 계좌, AGITQ_SYMBOLS: {TQQQ, SGOV, SPY, QQQ}
- 코드: /Users/jp/gwangsu/algo (GitHub: imjunejk/gwangsu)
- JuneClaw: /Users/jp/JuneClaw
`.trim();

export { SYSTEM_CONTEXT };

interface HandoffOptions {
  reason: string;
  currentWork?: string;
  progress?: string;
  errors?: string;
  nextAction?: string;
}

export async function writeHandoff(opts: HandoffOptions): Promise<void> {
  const now = new Date().toISOString();
  const sections = [
    `# Handoff`,
    ``,
    `**Time:** ${now}`,
    `**Reason:** ${opts.reason}`,
  ];

  if (opts.currentWork) {
    sections.push(``, `## Current Work`, opts.currentWork);
  }

  if (opts.progress) {
    sections.push(``, `## Progress`, opts.progress);
  }

  if (opts.errors) {
    sections.push(``, `## Errors / Blocked`, opts.errors);
  }

  if (opts.nextAction) {
    sections.push(``, `## First Action for Next Session`, opts.nextAction);
  }

  // 항상 시스템 컨텍스트 포함
  sections.push(``, SYSTEM_CONTEXT);

  sections.push(
    ``,
    `## Instructions`,
    `Review recent daily logs and HANDOFF context above. Delete this file after takeover.`,
  );

  const content = sections.join("\n") + "\n";
  await writeFile(join(config.workspace, "HANDOFF.md"), content, "utf-8");
}

const HANDOFF_PROMPT = `You are about to be shut down due to context window usage. Write a HANDOFF.md for the next session.

IMPORTANT: Include the System Context section EXACTLY as provided below — the next session needs this.

Follow this template — fill in every section based on your actual conversation context:

# HANDOFF — Active Session Transfer
## Created: {current timestamp}
## Current Work
(What you were working on — be specific: task name, file paths, decisions made)
## Progress
- [x] Completed steps
- [ ] In-progress steps
- [ ] Remaining steps
## Open Branches/PRs
(List any git branches or PRs in progress, or "None")
## Important Context
(Key decisions, constraints, user preferences expressed this session)
## Errors/Blocked Status
(Any errors encountered or blockers, or "None")
## First Action for Next Session
(The single most important thing to do immediately upon takeover)

${SYSTEM_CONTEXT}

Be concise but complete. The next session has NO memory of this conversation — everything it needs must be in this file.`;

export async function writeSmartHandoff(sessionId: string): Promise<RunResult> {
  const result = await runClaude({
    prompt: HANDOFF_PROMPT,
    systemPrompt: "You are Youngsu. Write the handoff document based on your conversation history. Include the System Context section.",
    sessionId,
  });

  let handoffContent = result.response;

  // Validate that Claude produced a meaningful handoff
  const hasStructure =
    handoffContent.includes("## Current Work") ||
    handoffContent.includes("## Progress") ||
    handoffContent.includes("# HANDOFF");
  if (!hasStructure || handoffContent.trim().length < 100) {
    throw new Error("Claude produced invalid handoff content");
  }

  // Ensure system context is included (Claude might skip it)
  if (!handoffContent.includes("## System Context")) {
    handoffContent += `\n\n${SYSTEM_CONTEXT}\n`;
  }

  await writeFile(join(config.workspace, "HANDOFF.md"), handoffContent, "utf-8");
  return result;
}

/**
 * Read HANDOFF.md content for quick-responder or other non-session contexts.
 * Returns empty string if file doesn't exist.
 */
export async function readHandoff(): Promise<string> {
  try {
    return await readFile(join(config.workspace, "HANDOFF.md"), "utf-8");
  } catch {
    return "";
  }
}
