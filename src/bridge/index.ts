/**
 * Bridge entry point — optional daemon integration.
 *
 * ACTIVATION: Add ONE line to src/daemon.ts after channels are created:
 *
 *   import("./bridge/index.js").then(m => m.initBridge(bridgeContext)).catch(e => log(`[bridge] ${e}`));
 *
 * Where `bridgeContext` is:
 *   const bridgeContext = {
 *     sendMessage: async (name, text) => {
 *       const entry = channelEntries.find(e => e.config.name === name || e.key === name);
 *       if (!entry) throw new Error(`Unknown channel: ${name}`);
 *       await entry.channel.sendMessage(text);
 *     },
 *     enqueueMessage: async (name, text, taskType) => {
 *       const entry = channelEntries.find(e => e.config.name === name || e.key === name);
 *       if (!entry) throw new Error(`Unknown channel: ${name}`);
 *       return await messageQueue.enqueue({ channelKey: entry.key, text, taskType });
 *     },
 *     getChannels: () => channelEntries.map(e => ({
 *       name: e.config.name,
 *       phone: e.config.phone,
 *       chatId: e.config.chatId,
 *       accessLevel: e.config.accessLevel ?? "full",
 *     })),
 *   };
 *
 * SAFETY:
 * - Bridge runs in a try-catch. If it crashes, daemon continues normally.
 * - Localhost-only (127.0.0.1). Not exposed to network.
 * - Write ops require JUNECLAW_BRIDGE_ALLOW_WRITE=1 env var.
 */
import { startBridge } from "./server.js";

export interface BridgeContext {
  sendMessage?: (channelName: string, text: string) => Promise<void>;
  sendToPhone?: (phone: string, text: string) => Promise<void>;
  enqueueMessage?: (channelName: string, text: string, taskType?: string) => Promise<string>;
  getChannels?: () => Array<{ name: string; phone: string; chatId: number; accessLevel: string }>;
}

export async function initBridge(ctx: BridgeContext = {}) {
  try {
    startBridge(ctx);
  } catch (err) {
    // NEVER propagate — daemon must keep running even if bridge fails
    console.warn(`[Bridge] Failed to start (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

export { startBridge, updateBridgeContext } from "./server.js";
