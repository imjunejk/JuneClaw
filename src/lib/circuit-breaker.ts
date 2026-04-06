/**
 * 3-state circuit breaker (CLOSED -> OPEN -> HALF_OPEN).
 * Pure Node.js — zero dependencies.
 *
 * CLOSED:    normal operation, failures are counted
 * OPEN:      fail-fast, skip execution until recovery timeout expires
 * HALF_OPEN: allow one probe call — success resets to CLOSED, failure reopens
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 3 */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN. Default: 60_000 */
  recoveryTimeoutMs?: number;
  /** Optional callback invoked on state transitions. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(message = "Circuit breaker is OPEN") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreaker {
  private _state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 60_000;
    this.onStateChange = opts.onStateChange;
  }

  get state(): CircuitState {
    // Lazily transition OPEN -> HALF_OPEN when recovery timeout expires
    if (
      this._state === "OPEN" &&
      Date.now() - this.lastFailureTime >= this.recoveryTimeoutMs
    ) {
      this.transition("HALF_OPEN");
    }
    return this._state;
  }

  /** Run `fn` through the circuit breaker. Throws CircuitBreakerOpenError if open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.state; // triggers lazy OPEN->HALF_OPEN check

    if (current === "OPEN") {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /** Force-reset the breaker to CLOSED state. */
  reset(): void {
    this.failureCount = 0;
    if (this._state !== "CLOSED") {
      this.transition("CLOSED");
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this._state !== "CLOSED") {
      this.transition("CLOSED");
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this._state === "HALF_OPEN") {
      // Probe failed — reopen immediately
      this.transition("OPEN");
    } else if (
      this._state === "CLOSED" &&
      this.failureCount >= this.failureThreshold
    ) {
      this.transition("OPEN");
    }
  }

  private transition(to: CircuitState): void {
    const from = this._state;
    this._state = to;
    if (to === "CLOSED") {
      this.failureCount = 0;
    }
    this.onStateChange?.(from, to);
  }
}
