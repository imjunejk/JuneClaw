# INCIDENT — 2026-04-24 02:30 UTC / HEARTBEAT-triggered duplicate trade execution

## What happened
Two Youngsu/general-session claude instances ran concurrently on the same session
and both executed June's Option A limit-buy orders. One duplicate MU x3 order
was created. Cancelled at 02:33 UTC (OID `8be71f60-2d7f-4334-a64d-85b872fbc7c8`,
204 OK).

## Timeline (UTC)
- 02:27:43 — June: "옵션 A로 하자. limit buy 로 bid 가 맞춰서 매수 실행해 줄 수 있어?"
- 02:27:46 — daemon dispatched general worker (job `2-15765`)
- 02:29:40–02:29:59 — **general worker** placed 6 orders (SNDK/MU/GOOG/NVDA/LRCX/KLAC x1)
- 02:30:00 — **HEARTBEAT** fired; spawned separate claude invocation
- 02:32:11 — HEARTBEAT-spawned session re-placed MU x3 (403 for the others — BP already consumed)
- 02:30:26 — general worker finished; posted "✅ 실행 완료 — Option A"
- 02:33:xx — HEARTBEAT-spawned session detected duplicate via open-orders scan, cancelled MU dup

## Root cause
`src/daemon.ts:821` — HEARTBEAT reuses the "general" sessionId (`getSessionId(phone, "general")`)
and kicks off a new `runClaude` call WITHOUT checking whether a general worker is already
processing a user message. The `progress-state.json` is written when a general job starts
(`writeProgressState`) and cleared on completion (`clearProgressState`), but HEARTBEAT
does not read this file before firing.

Both claude instances then saw the same conversation history (including the unanswered
user message), so both decided to "execute the plan" independently. The two processes
did not share an order-placement lock, so each independently hit Alpaca's `/v2/orders`.

## Why my instance re-executed
- My HEARTBEAT context included the in-progress user message from 02:27:43 and the
  "작업 진행 중" progress-monitor indicator at 02:28:04, but NOT the general worker's
  final response (which hadn't been written yet — it posted at 02:30:26).
- Classified as "pending unanswered request" → proceeded to act on Option A.

## R-E08 connection
This is the same class of failure as 2026-04-07 (two `remote-control --name juneclaw`
processes both handling iMessages). R-E08 covers process-level duplication at startup;
this incident shows the equivalent class within the daemon itself: HEARTBEAT firing
mid-job spawns a parallel processor on the same session.

## Proposed fix (not yet implemented)
In `src/daemon.ts` HEARTBEAT handler (line ~785):
```ts
// Before invoking runClaude, check if a general worker is active.
try {
  const state = JSON.parse(await readFile(config.progress.statePath, "utf8"));
  const age = Date.now() - state.startedAt;
  if (state.taskType === "general" && age < 5 * 60_000) {
    log("[heartbeat] skipping — general worker active");
    return;
  }
} catch { /* no active worker */ }
```

Secondary safeguard: trade-execution scripts should check open orders by
`client_order_id` prefix before submission. Example gate:
```py
# Skip if identical intent already open within last 10 min
recent = [o for o in open_orders
          if o["symbol"] == sym and (now - parse(o["created_at"])) < 600]
if recent: skip()
```

## Follow-up items
- [x] ~~PR to add HEARTBEAT progress-state gate (src/daemon.ts)~~ — JuneClaw PR #57 (activePhones gate + stateless HEARTBEAT + gate test)
- [ ] Add trade-execution idempotency check (gwangsu/algo — shared helper)
- [x] ~~Update R-E08 rule text to cover intra-daemon concurrency, not just process-level~~ — workspace master-rules.md updated 2026-04-24

## Orders left in place (1 session)
SNDK x2 @ $944, MU x3 @ $484.91, GOOG x6 @ $338.15, NVDA x8 @ $199.49,
LRCX x7 @ $260.25, KLAC x1 @ $1815.55. Total ~$10,604.
Cron `25 6 24 4 *` scheduled to cancel pre-open (06:25 PT Fri) so 09:56 PT
auto-rebalance can re-plan with live pricing.
