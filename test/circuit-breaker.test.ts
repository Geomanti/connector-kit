import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitOpenError } from "../src/index.js";

/** Deterministic clock so breaker timing is testable without real waits. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("breaker: stays closed while under the failure threshold", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  }
  assert.equal(cb.getState(), "closed");
});

test("breaker: opens once the threshold is reached", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  }
  assert.equal(cb.getState(), "open");
  assert.equal(cb.snapshot().totalOpened, 1);
});

test("breaker: fails fast while open, without calling the function", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  let called = false;
  await assert.rejects(
    () => cb.execute(async () => { called = true; return 1; }),
    (err: unknown) => err instanceof CircuitOpenError,
  );
  assert.equal(called, false, "an open breaker must not invoke the upstream call");
});

test("breaker: transitions to half-open after the reset timeout", async () => {
  const c = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000, now: c.now });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  assert.equal(cb.getState(), "open");
  c.advance(5_001);
  assert.equal(await cb.execute(async () => "probe-ok"), "probe-ok");
  assert.equal(cb.getState(), "closed", "a successful probe closes the circuit");
});

test("breaker: a failed probe reopens immediately", async () => {
  const c = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000, now: c.now });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  c.advance(5_001);
  await assert.rejects(() => cb.execute(async () => { throw new Error("still down"); }));
  assert.equal(cb.getState(), "open");
  assert.equal(cb.snapshot().totalOpened, 2);
});

test("breaker: allows only the configured number of half-open probes", async () => {
  const c = clock();
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    halfOpenProbes: 1,
    now: c.now,
  });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  c.advance(1_001);

  // First call occupies the only probe slot and never settles until we let it.
  let release: (() => void) | undefined;
  const inFlight = cb.execute(
    () => new Promise<string>((resolve) => { release = () => resolve("done"); }),
  );
  await assert.rejects(
    () => cb.execute(async () => "second"),
    (err: unknown) => err instanceof CircuitOpenError,
    "the second concurrent call must be refused while the probe is in flight",
  );
  release?.();
  assert.equal(await inFlight, "done");
});

test("breaker: success threshold can require more than one probe", async () => {
  const c = clock();
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    halfOpenProbes: 2,
    successThreshold: 2,
    now: c.now,
  });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  c.advance(1_001);
  await cb.execute(async () => "a");
  assert.equal(cb.getState(), "half-open", "one success is not enough when threshold is 2");
  await cb.execute(async () => "b");
  assert.equal(cb.getState(), "closed");
});

test("breaker: reset() forces the circuit closed", async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1 });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  assert.equal(cb.getState(), "open");
  cb.reset();
  assert.equal(cb.getState(), "closed");
  assert.equal(await cb.execute(async () => "ok"), "ok");
});

test("breaker: onStateChange reports transitions", async () => {
  const seen: string[] = [];
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1,
    onStateChange: (from, to) => seen.push(`${from}->${to}`),
  });
  await assert.rejects(() => cb.execute(async () => { throw new Error("boom"); }));
  await new Promise((r) => setTimeout(r, 5));
  await cb.execute(async () => "ok");
  assert.deepEqual(seen, ["closed->open", "open->half-open", "half-open->closed"]);
});
