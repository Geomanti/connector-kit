# connector-kit

Reliability primitives for third-party API integrations, in TypeScript.

Extracted from integration work on a live production platform, where the
recurring failure mode was never "the code is wrong" but **"the provider went
away and we handled it badly"**:

- no backoff, so every caller retried in lockstep and turned a blip into a storm;
- no breaker, so a dead upstream kept getting hammered and recovery was delayed;
- no replay protection on webhooks, so a captured delivery was processed twice.

This package is the set of primitives that fixes those three, plus the
observability to know they are working.

## Install

```bash
npm install connector-kit
```
Node 18+ (uses native `fetch`, `AbortController`, `node:crypto`).

## Quick start

```ts
import { ResilientClient } from "connector-kit";

const client = new ResilientClient({
  timeoutMs: 10_000,
  retry:   { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 20_000 },
  circuit: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  rateLimiter: { ratePerSecond: 10, burst: 20 },
  headers: { authorization: `Bearer ${process.env.TOKEN}` },
  onRequest: (e) => metrics.observe(e),
});

const devices = await client.getJson<Device[]>("https://api.provider.com/v1/devices");
```

The composition order is deliberate:

```
rate limiter  ->  circuit breaker  ->  retry  ->  fetch with timeout
```

Rate limit first (waiting for a slot is cheap and keeps us inside quota), breaker
next (fail fast when the provider is known-dead so retries do not worsen the
outage), retry innermost (backoff applies to real attempts only).

## What is in the box

| Export | What it does |
| --- | --- |
| `withRetry` | Exponential backoff with **full jitter**, `Retry-After` support, injectable sleep/clock |
| `CircuitBreaker` | closed / open / half-open with bounded concurrent probes and a success threshold |
| `TokenBucket` | Rate limiting with burst; `acquire()` waits for a slot instead of failing |
| `verifyWebhook` | HMAC-SHA256 over `timestamp.body`, constant-time compare, replay window |
| `ReplayGuard` | TTL-bounded event-id dedupe so a duplicate delivery is not processed twice |
| `ResilientClient` | `fetch` wrapper composing all of the above, with hooks |
| `Counter`, `Histogram`, `Registry` | Dependency-free Prometheus text exposition |

### Retry only what is retryable

A `404` or `400` is deterministic — retrying it burns the budget and delays the
real failure. The default policy retries timeouts, `408`, `429`, `5xx`, and the
transport codes that genuinely indicate a transient condition (`ECONNRESET`,
`ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`). Override with `shouldRetry`:

```ts
await withRetry(call, {
  maxAttempts: 6,
  shouldRetry: (err) => err instanceof HttpStatusError && err.status >= 500,
});
```

### Full jitter, not fixed delays

```
delay = random(0, min(maxDelay, base * 2^attempt))
```

A fixed delay means every caller that failed at the same moment retries at the
same moment — the storm repeats on each wave. Jitter decorrelates them.

`backoffDelay` and `parseRetryAfter` are exported so the policy is testable
directly rather than only observable through a live call.

### A provider's `Retry-After` beats our guess

If the upstream tells us how long to wait, that wins over our own backoff —
otherwise we ignore the one piece of information that is actually authoritative.

### Webhooks: verifying the payload is not optional

Anyone who knows the URL can POST to it. The signature covers
`${timestamp}.${rawBody}` so a captured request cannot be replayed outside the
tolerance window:

```ts
import { verifyWebhook, ReplayGuard } from "connector-kit";

const guard = new ReplayGuard();

app.post("/webhook", (req, res) => {
  // rawBody MUST be the exact bytes received — re-serialising JSON changes
  // whitespace and key order and will fail verification.
  verifyWebhook(req.rawBody, req.headers["x-signature"], {
    secret: process.env.WEBHOOK_SECRET!,
    toleranceSeconds: 300,
  });
  if (!guard.check(req.body.id)) return res.status(200).end(); // duplicate
  // ... handle
});
```

`verifyWebhook` throws `SignatureVerificationError`; wire it to a `400`, not a
`500` — a bad signature is a client problem, not a server fault.

### Metrics without a dependency

```ts
import { Counter, Histogram, Registry } from "connector-kit";

const registry = new Registry();
const requests = registry.register(
  new Counter("connector_requests_total", "Requests", ["provider", "status"]),
);
const latency = registry.register(
  new Histogram("connector_latency_seconds", "Latency", [0.05, 0.1, 0.25, 0.5, 1, 5], ["provider"]),
);

// in a request hook
requests.inc({ provider: "acme", status: 200 });
latency.observe(0.123, { provider: "acme" });

app.get("/metrics", (_req, res) => res.type("text/plain").send(registry.render()));
```

Histogram buckets render **cumulatively**, as Prometheus requires — `le="0.5"`
counts everything at or below 0.5.

## Design notes

- **No runtime dependencies.** Observability should never be a deployment
  prerequisite; the metrics module is ~100 lines rather than a client library.
- **Injectable clock, sleep and RNG everywhere.** Backoff and breaker timing are
  tested without waiting in real time — which is why the test suite runs in
  well under a second.
- **`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on.** The
  strictness is the point: the errors this library exists to prevent are the
  ones that only appear under load.

## Tests

```bash
npm run build
npm test
```

45 tests covering retry classification, backoff maths, breaker state machine
(including half-open probe limits and reopen-on-failed-probe), rate-limit
refill, webhook forgery / tampering / replay, and end-to-end client composition
against a scripted `fetch`.

## Limits

Honest scope, so you can judge fit:

- `TokenBucket` and `ReplayGuard` are **in-process**. For a multi-instance
  deployment the quota and the dedupe set must move to shared storage
  (Redis or similar) — a per-process limiter does not enforce a global quota.
- The metrics registry is a minimal exposition layer, not a client library: no
  push gateway, no exemplars, no native histograms.
- `ResilientClient` wraps a single request/response cycle. It has no retry
  queue, so a long-running job should be handed to a durable worker rather than
  held open in a retry loop.

## License

MIT
