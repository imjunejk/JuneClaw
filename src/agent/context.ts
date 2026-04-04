import { buildSystemPrompt } from "../memory/loader.js";

export async function buildContext(): Promise<string> {
  const systemPrompt = await buildSystemPrompt();
  if (!systemPrompt) {
    return "You are clawd, a helpful personal AI assistant communicating via iMessage. Be concise and natural.";
  }
  return systemPrompt;
}
