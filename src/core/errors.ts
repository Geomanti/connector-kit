/**
 * Error types shared across the reliability primitives.
 *
 * Kept in their own module so retry.ts and circuit-breaker.ts can both import
 * them without importing each other (a cycle that would otherwise make
 * `instanceof` checks order-dependent).
 */

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText?: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpStatusError";
  }
}

export class TimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly url: string,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Circuit is open; next probe allowed in ${retryAfterMs}ms`);
    this.name = "CircuitOpenError";
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded; retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

export class SignatureVerificationError extends Error {
  constructor(reason: string) {
    super(`Webhook signature verification failed: ${reason}`);
    this.name = "SignatureVerificationError";
  }
}
