import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

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
