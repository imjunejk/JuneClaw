/**
 * Quality Scorer — automatic conversation quality scoring.
 *
 * Scores each exchange on a 0.0–1.0 scale using lightweight signal
 * detection (no extra LLM call). Signals are derived from the user's
 * *next* message and from runtime metrics collected during the exchange.
 *
 * The score feeds into the score ledger (score-ledger.ts), which in
 * turn drives the strategy-tuner hill-climbing loop.
 */

import type { TaskType } from "../config.js";

// ── Signal weights ──────────────────────────────────────────────────
// Each signal contributes a delta to the base score (0.5).
// Positive signals raise the score; negative signals lower it.
// The final score is clamped to [0, 1].

interface SignalWeight {
  /** Regex applied to the user's *follow-up* message (case-insensitive). */
  pattern: RegExp;
  /** Delta applied to the base score when the pattern matches. */
  delta: number;
  /** Human-readable label for the ledger. */
  label: string;
}

const POSITIVE_FOLLOW_UP: SignalWeight[] = [
  { pattern: /(?:고마워|감사|땡큐|thanks|thx|thank you|ㄱㅅ|ㄳ|👍|잘\s*했)/i, delta: 0.2, label: "gratitude" },
  { pattern: /(?:좋아|완벽|perfect|great|nice|좋[네은]|굿|잘\s*됐|ㅇㅋ|ㅇㅇ|넵|네네)/i, delta: 0.15, label: "acceptance" },
  { pattern: /(?:ㅋ{2,}|ㅎ{2,}|😂|🤣|😄)/i, delta: 0.05, label: "amusement" },
];

const NEGATIVE_FOLLOW_UP: SignalWeight[] = [
  { pattern: /(?:아니|아닌데|그게\s*아니|다시|다시\s*해|틀렸|잘못|wrong|no\s*not|that'?s\s*not)/i, delta: -0.25, label: "correction" },
  { pattern: /(?:왜\s*(?:이래|그래|안\s*돼)|뭐야\s*이게|이상한데|이상해)/i, delta: -0.2, label: "confusion" },
  { pattern: /(?:느려|오래\s*걸|너무\s*길|too\s*long|slow)/i, delta: -0.1, label: "slow" },
];

// ── Runtime signal modifiers ────────────────────────────────────────

export interface ExchangeMetrics {
  /** Was this a retry after a previous error? */
  wasRetry: boolean;
  /** Did the runner hit a timeout? */
  timedOut: boolean;
  /** Session was force-rotated right after this exchange. */
  forceRotated: boolean;
  /** Context window usage percent at time of response. */
  usagePercent: number;
  /** Cost of this single exchange in USD. */
  costUSD: number;
  /** Number of turns the agent used. */
  numTurns: number;
}

const DEFAULT_METRICS: ExchangeMetrics = {
  wasRetry: false,
  timedOut: false,
  forceRotated: false,
  usagePercent: 0,
  costUSD: 0,
  numTurns: 1,
};

export interface ScoreResult {
  /** Final score clamped to [0, 1]. */
  score: number;
  /** Matched signal labels for the ledger. */
  signals: string[];
}

/**
 * Score an exchange based on the user's *follow-up* message.
 *
 * Call this when the *next* user message arrives — pass the new message
 * as `followUpMessage` and the runtime metrics from the *previous*
 * exchange as `metrics`.
 *
 * If no follow-up is available yet (e.g. session ended), pass
 * `followUpMessage = undefined` to score purely on runtime metrics.
 */
export function scoreExchange(
  followUpMessage: string | undefined,
  metrics: Partial<ExchangeMetrics> = {},
): ScoreResult {
  const m = { ...DEFAULT_METRICS, ...metrics };
  let score = 0.5; // neutral baseline
  const signals: string[] = [];

  // ── Follow-up signals ───────────────────────────────────────────
  // Cap total contribution from follow-up to prevent score stacking
  // when a message matches multiple patterns.
  const MAX_FOLLOWUP_POSITIVE = 0.3;
  const MAX_FOLLOWUP_NEGATIVE = -0.3;

  if (followUpMessage) {
    let positiveDelta = 0;
    let negativeDelta = 0;

    for (const { pattern, delta, label } of POSITIVE_FOLLOW_UP) {
      if (pattern.test(followUpMessage)) {
        positiveDelta += delta;
        signals.push(`+${label}`);
      }
    }
    for (const { pattern, delta, label } of NEGATIVE_FOLLOW_UP) {
      if (pattern.test(followUpMessage)) {
        negativeDelta += delta; // delta is already negative
        signals.push(`-${label}`);
      }
    }

    score += Math.min(positiveDelta, MAX_FOLLOWUP_POSITIVE);
    score += Math.max(negativeDelta, MAX_FOLLOWUP_NEGATIVE);
  }

  // ── Runtime metric signals ──────────────────────────────────────
  if (m.timedOut) {
    score -= 0.3;
    signals.push("-timeout");
  }
  if (m.wasRetry) {
    score -= 0.15;
    signals.push("-retry");
  }
  if (m.forceRotated) {
    score -= 0.1;
    signals.push("-force_rotated");
  }
  // High context usage is a mild negative (response may degrade)
  if (m.usagePercent >= 80) {
    score -= 0.05;
    signals.push("-high_context");
  }
  // Multi-turn exchanges that took many turns suggest struggle
  if (m.numTurns > 5) {
    score -= 0.1;
    signals.push("-many_turns");
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    signals,
  };
}

/**
 * Convenience: score an exchange that ended in an error.
 * Always returns a low score regardless of follow-up.
 */
export function scoreError(errorMessage: string): ScoreResult {
  const signals = ["-error"];
  if (errorMessage.includes("TIMEOUT")) signals.push("-timeout");
  return { score: 0.1, signals };
}
