import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { runClaude, type RunResult } from "../agent/runner.js";

// ── System Context (항상 핸드오프에 포함) ──────────────────
const SYSTEM_CONTEXT = `
## System Context (광수 트레이딩 시스템)
육사 전략 = AgiTQ 60% + SEPA 40%
- AgiTQ: TQQQ 200일선 3구간 (하락→SGOV / 집중투자→TQQQ 2일확인 / 과열→SPY)
- SEPA: TT 8/8 개별주식 + ETF, VCP v2.0, -10% 스탑
- 매매는 portfolio_manager.py가 통합 관리 (유일한 매매 주체)
- 크론 스케줄 (PT):
  월 06:20 리밸런싱 | 06:25 SEPA 스캔+리밋 | 06:35 SEPA 체결확인
  12:50 AgiTQ 준비 | 12:57 AgiTQ 실행(종가 3분전 market) | 13:02 AgiTQ followup(limit)
- Alpaca 라이브 계좌, AGITQ_SYMBOLS: {TQQQ, SGOV, SPY}
- 코드: /Users/jp/gwangsu-algo (GitHub: imjunejk/gwangsu-algo)
- JuneClaw: /Users/jp/JuneClaw (GitHub: imjunejk/gwangsu)
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
