import { appendSystemLog } from "../memory/writer.js";

export type DaemonEvent =
  | "daemon:startup"
  | "daemon:shutdown"
  | "heartbeat:ok"
  | "heartbeat:action"
  | "heartbeat:failed"
  | "message:received"
  | "message:responded"
  | "message:error"
  | "cron:started"
  | "cron:completed"
  | "cron:failed"
  | "rotation:triggered"
  | "agent:orphan_detected";

type EventHandler = (event: DaemonEvent, data?: Record<string, unknown>) => void | Promise<void>;

const handlers = new Map<DaemonEvent, EventHandler[]>();
const globalHandlers: EventHandler[] = [];

export function on(event: DaemonEvent, handler: EventHandler): () => void {
  const list = handlers.get(event) ?? [];
  list.push(handler);
  handlers.set(event, list);
  return () => {
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  };
}

export function onAny(handler: EventHandler): () => void {
  globalHandlers.push(handler);
  return () => {
    const idx = globalHandlers.indexOf(handler);
    if (idx >= 0) globalHandlers.splice(idx, 1);
  };
}

export async function emit(
  event: DaemonEvent,
  data?: Record<string, unknown>,
): Promise<void> {
  const all = [...globalHandlers, ...(handlers.get(event) ?? [])];
  await Promise.allSettled(
    all.map((handler) =>
      Promise.resolve(handler(event, data)).catch((err) => {
        console.error(`[hook] ${event} handler failed:`, err);
      }),
    ),
  );
}

// Built-in: log all events to system log
onAny(async (event, data) => {
  const detail = data ? ` ${JSON.stringify(data)}` : "";
  await appendSystemLog(`[event] ${event}${detail}`).catch(() => {});
});
