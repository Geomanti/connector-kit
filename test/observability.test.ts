import test from "node:test";
import assert from "node:assert/strict";
import { TokenBucket, Counter, Histogram, Registry } from "../dist/index.js";

test("rate limiter: permits an initial burst up to the bucket size", async () => {
  const tb = new TokenBucket({ ratePerSecond: 2, burst: 3, now: () => 0, sleep: async () => {} });
  assert.equal(tb.tryAcquire(), true);
  assert.equal(tb.tryAcquire(), true);
  assert.equal(tb.tryAcquire(), true);
  assert.equal(tb.tryAcquire(), false, "burst exhausted");
});

test("rate limiter: refills over time", () => {
  let t = 0;
  const tb = new TokenBucket({ ratePerSecond: 1, burst: 1, now: () => t, sleep: async () => {} });
  assert.equal(tb.tryAcquire(), true);
  assert.equal(tb.tryAcquire(), false);
  t += 1_000; // one second -> one token
  assert.equal(tb.tryAcquire(), true);
});

test("rate limiter: acquire() waits for a slot rather than failing", async () => {
  let t = 0;
  const waits: number[] = [];
  const tb = new TokenBucket({
    ratePerSecond: 2,
    burst: 1,
    now: () => t,
    sleep: async (ms) => { waits.push(ms); t += ms; },
  });
  assert.equal(await tb.acquire(), 0);
  const waited = await tb.acquire();
  assert.ok(waited > 0, "second acquire must wait");
  assert.equal(waits.length, 1);
});

test("rate limiter: rejects an invalid rate", () => {
  assert.throws(() => new TokenBucket({ ratePerSecond: 0 }), RangeError);
});

test("metrics: Counter renders Prometheus exposition format", () => {
  const c = new Counter("http_requests_total", "Total requests", ["method", "status"]);
  c.inc({ method: "GET", status: 200 });
  c.inc({ method: "GET", status: 200 });
  c.inc({ method: "POST", status: 500 });
  const out = c.render().join("\n");
  assert.match(out, /# TYPE http_requests_total counter/);
  assert.match(out, /http_requests_total\{method="GET",status="200"\} 2/);
  assert.match(out, /http_requests_total\{method="POST",status="500"\} 1/);
});

test("metrics: Counter labels are order-independent", () => {
  const c = new Counter("x_total", "h", ["a", "b"]);
  c.inc({ a: "1", b: "2" });
  c.inc({ b: "2", a: "1" });
  const out = c.render().join("\n");
  assert.match(out, /x_total\{a="1",b="2"\} 2/, "same labels must accumulate regardless of key order");
});

test("metrics: Histogram renders cumulative buckets, sum and count", () => {
  const h = new Histogram("latency_seconds", "Latency", [0.1, 0.5, 1], ["route"]);
  h.observe(0.05, { route: "/a" });
  h.observe(0.3, { route: "/a" });
  h.observe(5, { route: "/a" });
  const out = h.render().join("\n");
  assert.match(out, /latency_seconds_bucket\{route="\/a",le="0.1"\} 1/);
  assert.match(out, /latency_seconds_bucket\{route="\/a",le="0.5"\} 2/);
  assert.match(out, /latency_seconds_bucket\{route="\/a",le="1"\} 2/);
  assert.match(out, /latency_seconds_bucket\{route="\/a",le="\+Inf"\} 3/);
  assert.match(out, /latency_seconds_count\{route="\/a"\} 3/);
  assert.match(out, /latency_seconds_sum\{route="\/a"\} 5\.35/);
});

test("metrics: Registry renders every registered metric", () => {
  const reg = new Registry();
  const c = reg.register(new Counter("a_total", "h"));
  reg.register(new Histogram("b_seconds", "h", [1]));
  c.inc();
  const out = reg.render();
  assert.match(out, /a_total 1/);
  assert.match(out, /# TYPE b_seconds histogram/);
});
