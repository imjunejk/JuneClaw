import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { runClaude } from "../agent/runner.js";

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

  sections.push(
    ``,
    `## Instructions`,
    `Review recent daily logs for full context. Delete this file after takeover.`,
  );

  const content = sections.join("\n") + "\n";
  await writeFile(join(config.workspace, "HANDOFF.md"), content, "utf-8");
}

const HANDOFF_PROMPT = `You are about to be shut down due to context window usage. Write a HANDOFF.md for the next session.

Follow this exact template — fill in every section based on your actual conversation context:

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

Be concise but complete. The next session has NO memory of this conversation — everything it needs must be in this file.`;

export async function writeSmartHandoff(sessionId: string): Promise<string> {
  const result = await runClaude({
    prompt: HANDOFF_PROMPT,
    systemPrompt: "You are Youngsu. Write the handoff document based on your conversation history.",
    sessionId,
  });

  const handoffContent = result.response;
  await writeFile(join(config.workspace, "HANDOFF.md"), handoffContent, "utf-8");
  return handoffContent;
}
