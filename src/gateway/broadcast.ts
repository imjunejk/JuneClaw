import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

interface Recipient {
  name: string;
  channel: string;
  target: string;
  reports: string[];
}

interface RecipientsFile {
  recipients: Recipient[];
  report_types: Record<string, string>;
}

let cached: RecipientsFile | null = null;

async function loadRecipients(): Promise<RecipientsFile> {
  if (cached) return cached;
  const raw = await readFile(config.broadcast.recipientsPath, "utf-8");
  cached = JSON.parse(raw) as RecipientsFile;
  return cached;
}

/** Clear cached recipients so next broadcast re-reads the file. */
export function reloadRecipients(): void {
  cached = null;
}

function recipientMatchesReport(r: Recipient, reportType: string): boolean {
  return r.reports.includes("all") || r.reports.includes(reportType);
}

async function sendImessage(target: string, text: string): Promise<void> {
  const maxLen = 4000;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  for (const chunk of chunks) {
    await execFileAsync("imsg", ["send", "--to", target, "--text", chunk]);
  }
}

/**
 * Broadcast a message to all recipients subscribed to the given report type.
 * Returns the list of recipient names that were sent to.
 */
export async function broadcast(
  reportType: string,
  message: string,
): Promise<string[]> {
  const { recipients } = await loadRecipients();
  const targets = recipients.filter((r) =>
    recipientMatchesReport(r, reportType),
  );

  const sent: string[] = [];
  for (const r of targets) {
    if (r.channel !== "imessage") continue;
    try {
      await sendImessage(r.target, message);
      sent.push(r.name);
    } catch (err) {
      console.error(`[broadcast] failed to send to ${r.name}:`, err);
    }
  }

  return sent;
}

/** List all available report types. */
export async function listReportTypes(): Promise<Record<string, string>> {
  const { report_types } = await loadRecipients();
  return report_types;
}

/** List recipients for a given report type. */
export async function listRecipients(
  reportType?: string,
): Promise<Recipient[]> {
  const { recipients } = await loadRecipients();
  if (!reportType) return recipients;
  return recipients.filter((r) => recipientMatchesReport(r, reportType));
}
