/**
 * Token-bucket rate limiter.
 *
 * Providers publish a quota; callers that ignore it get 429s and, worse, get
 * the whole integration throttled. A token bucket models the common "N requests
 * per window, with a small burst allowance" shape and lets callers *wait* for a
 * slot rather than discover the limit by failing.
 */

export interface RateLimiterOptions {
  /** Sustained requests permitted per second. Default 5. */
  ratePerSecond?: number;
  /** Maximum burst size. Defaults to the per-second rate. */
  burst?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RateLimiterOptions = {}) {
    this.ratePerSecond = options.ratePerSecond ?? 5;
    if (this.ratePerSecond <= 0) throw new RangeError("ratePerSecond must be > 0");
    this.burst = options.burst ?? this.ratePerSecond;
    this.tokens = this.burst;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastRefill = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = (nowMs - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefill = nowMs;
  }

  /** Tokens available right now, after refill. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Take one token, waiting if necessary.
   * Returns the number of milliseconds it had to wait.
   */
  async acquire(): Promise<number> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil((deficit / this.ratePerSecond) * 1000);
    await this.sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return waitMs;
  }

  /** Non-blocking check: returns false if no token is available. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
