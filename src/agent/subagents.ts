import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

const lifecycleScript = `${config.subAgents.toolsPath}/agent-lifecycle.sh`;
const mailboxScript = `${config.subAgents.toolsPath}/mailbox.sh`;

async function runTool(script: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(script, args, { timeout: 10_000 });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[error] ${msg}`;
  }
}

export async function registerAgent(
  id: string,
  parentId: string,
  label: string,
): Promise<string> {
  return runTool(lifecycleScript, ["register", id, parentId, label]);
}

export async function completeAgent(
  id: string,
  status: "success" | "failure",
): Promise<string> {
  return runTool(lifecycleScript, ["complete", id, status]);
}

export async function cascadeKill(parentId: string): Promise<string> {
  return runTool(lifecycleScript, ["cascade-kill", parentId]);
}

export async function listAgentStatus(): Promise<string> {
  return runTool(lifecycleScript, ["status"]);
}

export async function listOrphans(): Promise<string> {
  return runTool(lifecycleScript, ["orphans"]);
}

export async function cleanupStaleAgents(): Promise<string> {
  const orphans = await listOrphans();
  if (!orphans || orphans.includes("[error]") || orphans.trim() === "") {
    return "no orphans";
  }
  // Kill each orphan by its own ID
  const ids = orphans.split("\n").map((l) => l.trim()).filter(Boolean);
  const results: string[] = [];
  for (const id of ids) {
    results.push(await runTool(lifecycleScript, ["cascade-kill", id]));
  }
  return `killed ${ids.length} orphans: ${results.join("; ")}`;
}

export async function sendMailbox(
  to: string,
  message: string,
): Promise<string> {
  return runTool(mailboxScript, ["send", to, message]);
}

export async function readMailbox(agent: string): Promise<string> {
  return runTool(mailboxScript, ["read", agent]);
}
