/**
 * Retry with exponential backoff and full jitter.
 *
 * The point is not "try again" — it is to avoid the thundering herd that a
 * fixed delay produces when a provider goes down and every caller retries in
 * lockstep. Full jitter (sleep = random(0, min(cap, base * 2^attempt))) is the
 * AWS-recommended variant and is what this implements.
 */

import { CircuitOpenError, HttpStatusError, RateLimitError, TimeoutError } from "./errors.js";

export type { RetryEvent } from "./types.js";
import type { RetryEvent } from "./types.js";

export interface RetryOptions {
  /** Maximum number of attempts, including the first. Default 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds for the first backoff. Default 250. */
  baseDelayMs?: number;
  /** Ceiling for a single delay in milliseconds. Default 20_000. */
  maxDelayMs?: number;
  /**
   * Decide whether an error is worth retrying. Defaults to
   * {@link defaultShouldRetry}: network errors, timeouts, 408, 429 and 5xx.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each backoff sleep. Useful for logging/metrics. */
  onRetry?: (info: RetryEvent) => void;
  /** Injectable sleep, so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable RNG (0..1), so backoff is deterministic in tests. */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retryable by default: transient network conditions and the status codes a
 * provider documents as retryable. A 404 or 400 is NOT retried — retrying a
 * deterministic client error just burns the budget and delays the real failure.
 */
export function defaultShouldRetry(error: unknown, attempt: number): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (error instanceof TimeoutError) return true;
  if (error instanceof RateLimitError) return true;
  if (error instanceof HttpStatusError) {
    const s = error.status;
    return s === 408 || s === 429 || (s >= 500 && s <= 599);
  }
  // Unknown/transport-level failures (ECONNRESET, socket hang up, DNS) — retry.
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string") {
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"].includes(code);
  }
  return attempt === 0;
}

/**
 * Compute the backoff for a given attempt using full jitter.
 * Exported so it can be unit-tested directly.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  // A provider that tells us how long to wait wins over our own guess.
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, maxDelayMs);
  const exponential = baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, maxDelayMs);
  return Math.floor(random() * capped);
}

/** Parse a `Retry-After` header in either delta-seconds or HTTP-date form. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 20_000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(error, attempt)) throw error;

      const retryAfterMs = error instanceof RateLimitError ? error.retryAfterMs : undefined;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random, retryAfterMs);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
