import test from "node:test";
import assert from "node:assert/strict";
import {
  withRetry,
  defaultShouldRetry,
  backoffDelay,
  parseRetryAfter,
  HttpStatusError,
  TimeoutError,
  CircuitOpenError,
  RateLimitError,
} from "../src/index.js";

const noSleep = async () => {};

test("retry: succeeds on the first attempt without sleeping", async () => {
  let calls = 0;
  let slept = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { sleep: async () => { slept++; } },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test("retry: retries a 500 then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async (attempt) => {
      calls++;
      if (attempt < 2) throw new HttpStatusError(500, "https://x.test");
      return "recovered";
    },
    { sleep: noSleep, random: () => 0.5 },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("retry: does NOT retry a 404 (deterministic client error)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new HttpStatusError(404, "https://x.test");
        },
        { sleep: noSleep },
      ),
    (err: unknown) => err instanceof HttpStatusError && err.status === 404,
  );
  assert.equal(calls, 1, "a 404 must fail immediately, not burn the retry budget");
});

test("retry: exhausts attempts and throws the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new HttpStatusError(503, "https://x.test");
        },
        { sleep: noSleep, maxAttempts: 3, random: () => 0 },
      ),
    (err: unknown) => err instanceof HttpStatusError && err.status === 503,
  );
  assert.equal(calls, 3);
});

test("retry: honours Retry-After from a 429 instead of its own backoff", async () => {
  const delays: number[] = [];
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw new RateLimitError(7_000);
      },
      {
        sleep: async (ms) => { delays.push(ms); },
        maxAttempts: 3,
        random: () => 0,
      },
    ),
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [7_000, 7_000], "the provider's Retry-After wins over our guess");
});

test("retry: a CircuitOpenError is never retries", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new CircuitOpenError(30_000);
        },
        { sleep: noSleep },
      ),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  assert.equal(calls, 1);
});

test("retry: transport error codes are retryable, unknown errors are not", () => {
  assert.equal(defaultShouldRetry(Object.assign(new Error("x"), { code: "ECONNRESET" }), 0), true);
  assert.equal(defaultShouldRetry(Object.assign(new Error("x"), { code: "EAI_AGAIN" }), 0), true);
  assert.equal(defaultShouldRetry(new TimeoutError(1000, "u"), 0), true);
  assert.equal(defaultShouldRetry(new HttpStatusError(408, "u"), 0), true);
  assert.equal(defaultShouldRetry(new HttpStatusError(429, "u"), 0), true);
  assert.equal(defaultShouldRetry(new HttpStatusError(400, "u"), 0), false);
});

test("backoffDelay: grows exponentially with full jitter, capped", () => {
  const r = () => 1; // deterministic upper bound
  assert.equal(backoffDelay(0, 100, 10_000, r), 100);
  assert.equal(backoffDelay(1, 100, 10_000, r), 200);
  assert.equal(backoffDelay(2, 100, 10_000, r), 400);
  assert.equal(backoffDelay(10, 100, 10_000, r), 10_000, "must cap, not explode");
  const jittered = backoffDelay(3, 100, 10_000, () => 0.5);
  assert.equal(jittered, Math.floor(0.5 * 800));
});

test("parseRetryAfter: delta-seconds and HTTP-date forms", () => {
  assert.equal(parseRetryAfter("120"), 120_000);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter("garbage"), undefined);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30_000);
});
