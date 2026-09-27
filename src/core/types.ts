/** Small shared types. */

export interface RetryEvent {
  /** 1-based attempt number that is about to be retried. */
  attempt: number;
  delayMs: number;
  error: unknown;
}

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitSnapshot {
  state: CircuitState;
  failures: number;
  successes: number;
  openedAt?: number;
  totalOpened: number;
}
