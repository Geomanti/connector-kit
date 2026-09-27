/**
 * Circuit breaker with half-open probing.
 *
 * Purpose: when an upstream provider is failing, stop hammering it. A retry
 * policy alone makes an outage worse — every caller keeps retrying into a dead
 * service and the retry storm delays recovery. The breaker fails fast instead,
 * and lets a bounded number of probes through while half-open so recovery is
 * detected without reopening the floodgates.
 */

import { CircuitOpenError } from "./errors.js";
import type { CircuitSnapshot, CircuitState } from "./types.js";

export type { CircuitSnapshot, CircuitState } from "./types.js";

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing probes, ms. Default 30_000. */
  resetTimeoutMs?: number;
  /** Probes allowed while half-open. Default 1. */
  halfOpenProbes?: number;
  /** Consecutive successes while half-open before closing. Default 1. */
  successThreshold?: number;
  /** Called whenever the breaker changes state. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private inFlightProbes = 0;
  private totalOpened = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenProbes: number;
  private readonly successThreshold: number;
  private readonly now: () => number;
  private readonly onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenProbes = options.halfOpenProbes ?? 1;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /** Throw if a call is not permitted right now. */
  private assertAllowed(): boolean {
    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.resetTimeoutMs - elapsed);
      }
      this.transitionTo("half-open");
    }
    if (this.state === "half-open") {
      // Only a bounded number of probes may be in flight at once.
      if (this.inFlightProbes >= this.halfOpenProbes) {
        throw new CircuitOpenError(this.resetTimeoutMs);
      }
      this.inFlightProbes++;
      return true;
    }
    return false;
  }

  private transitionTo(next: CircuitState): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    if (next === "open") {
      this.openedAt = this.now();
      this.totalOpened++;
    }
    if (next === "closed") {
      this.failures = 0;
      this.successes = 0;
      this.inFlightProbes = 0;
    }
    if (next === "half-open") {
      this.successes = 0;
      this.inFlightProbes = 0;
    }
    this.onStateChange?.(from, next);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const wasProbe = this.assertAllowed();
    try {
      const result = await fn();
      this.onSuccess(wasProbe);
      return result;
    } catch (error) {
      this.onFailure(wasProbe);
      throw error;
    }
  }

  private onSuccess(wasProbe: boolean): void {
    if (wasProbe) {
      this.inFlightProbes = Math.max(0, this.inFlightProbes - 1);
      this.successes++;
      if (this.successes >= this.successThreshold) this.transitionTo("closed");
      return;
    }
    if (this.state === "closed") this.failures = 0;
  }

  private onFailure(wasProbe: boolean): void {
    if (wasProbe) {
      this.inFlightProbes = Math.max(0, this.inFlightProbes - 1);
      // A failed probe means the provider is still unhealthy: reopen at once.
      this.transitionTo("open");
      return;
    }
    this.failures++;
    if (this.state === "closed" && this.failures >= this.failureThreshold) {
      this.transitionTo("open");
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  snapshot(): CircuitSnapshot {
    const snap: CircuitSnapshot = {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      totalOpened: this.totalOpened,
    };
    if (this.state === "open") snap.openedAt = this.openedAt;
    return snap;
  }

  /** Force the breaker closed — for tests and for an operator override. */
  reset(): void {
    this.transitionTo("closed");
  }
}
