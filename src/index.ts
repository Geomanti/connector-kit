/**
 * connector-kit — reliability primitives for third-party API integrations.
 *
 * Extracted from the integration work on a live production platform where the
 * recurring failure mode was never "the code is wrong" but "the provider went
 * away and we handled it badly": no backoff, so all callers retried in
 * lockstep; no breaker, so a dead upstream got hammered until recovery was
 * delayed; no replay protection on webhooks, so a captured delivery was
 * processed twice.
 */

export {
  withRetry,
  defaultShouldRetry,
  backoffDelay,
  parseRetryAfter,
  type RetryOptions,
} from "./core/retry.js";

export {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from "./core/circuit-breaker.js";

export {
  TokenBucket,
  type RateLimiterOptions,
} from "./core/rate-limiter.js";

export {
  HttpStatusError,
  TimeoutError,
  CircuitOpenError,
  RateLimitError,
  SignatureVerificationError,
} from "./core/errors.js";

export type {
  RetryEvent,
  CircuitState,
  CircuitSnapshot,
} from "./core/types.js";

export {
  verifyWebhook,
  computeSignature,
  parseSignatureHeader,
  ReplayGuard,
  type VerifyOptions,
  type ParsedSignatureHeader,
} from "./webhooks/verify.js";

export {
  ResilientClient,
  type ResilientClientOptions,
  type RequestEvent,
  type ResilientResponse,
} from "./http/client.js";

export {
  Counter,
  Histogram,
  Registry,
  type MetricLabels,
} from "./observability/metrics.js";
