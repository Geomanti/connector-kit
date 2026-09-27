/**
 * A fetch wrapper that composes the reliability primitives.
 *
 * This is the piece that makes the library useful rather than illustrative: the
 * order of composition matters and is deliberate.
 *
 *   rate limiter  ->  circuit breaker  ->  retry  ->  fetch with timeout
 *
 * Rate limit first: waiting for a slot is cheap and keeps us inside quota.
 * Breaker next: fail fast when the provider is known-dead, so retries do not
 * make an outage worse. Retry innermost: backoff applies to real attempts only.
 */

import { HttpStatusError, RateLimitError, TimeoutError } from "../core/errors.js";
import { withRetry, parseRetryAfter, type RetryOptions } from "../core/retry.js";
import { CircuitBreaker, type CircuitBreakerOptions } from "../core/circuit-breaker.js";
import { TokenBucket, type RateLimiterOptions } from "../core/rate-limiter.js";

export interface ResilientClientOptions {
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  retry?: RetryOptions;
  circuit?: CircuitBreakerOptions;
  rateLimiter?: RateLimiterOptions;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  /** Observability hook, called after each completed attempt. */
  onRequest?: (event: RequestEvent) => void;
  /** fetch implementation, injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface RequestEvent {
  url: string;
  method: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  error?: unknown;
}

export interface ResilientResponse {
  status: number;
  headers: Headers;
  body: string;
}

export class ResilientClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucket;
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions;
  private readonly extraHeaders: Record<string, string>;
  private readonly onRequest: ((event: RequestEvent) => void) | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResilientClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.breaker = new CircuitBreaker(options.circuit);
    this.limiter = new TokenBucket(options.rateLimiter);
    this.retryOptions = options.retry ?? {};
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (options.onRequest) this.onRequest = options.onRequest;
  }

  async request(
    url: string,
    init: RequestInit = {},
    attempt = 0,
  ): Promise<ResilientResponse> {
    await this.limiter.acquire();

    return this.breaker.execute(() =>
      withRetry(
        async () => {
          const started = Date.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const res = await this.fetchImpl(url, {
              ...init,
              signal: controller.signal,
              headers: { ...this.extraHeaders, ...(init.headers as Record<string, string>) },
            });
            const body = await res.text();

            if (!res.ok) {
              if (res.status === 429) {
                const wait = parseRetryAfter(res.headers.get("retry-after")) ?? 1_000;
                throw new RateLimitError(wait);
              }
              throw new HttpStatusError(res.status, url, body.slice(0, 500));
            }
            this.onRequest?.({
              url,
              method: init.method ?? "GET",
              status: res.status,
              durationMs: Date.now() - started,
              attempt,
            });
            return { status: res.status, headers: res.headers, body };
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
              throw new TimeoutError(this.timeoutMs, url);
            }
            this.onRequest?.({
              url,
              method: init.method ?? "GET",
              status: null,
              durationMs: Date.now() - started,
              attempt,
              error,
            });
            throw error;
          } finally {
            clearTimeout(timer);
          }
        },
        { ...this.retryOptions },
      ),
    );
  }

  /** Convenience: GET and parse JSON. */
  async getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, { ...init, method: "GET" });
    return JSON.parse(res.body) as T;
  }

  snapshot() {
    return { circuit: this.breaker.snapshot(), tokens: this.limiter.available() };
  }
}
