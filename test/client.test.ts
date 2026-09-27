import test from "node:test";
import assert from "node:assert/strict";
import {
  ResilientClient,
  CircuitOpenError,
  RateLimitError,
  HttpStatusError,
} from "../dist/index.js";

/** Build a fake fetch that returns a scripted sequence of responses. */
function scriptedFetch(script: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const calls: string[] = [];
  const impl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    const next = script[Math.min(i, script.length - 1)];
    i++;
    return await next!();
  };
  return { impl: impl as unknown as typeof fetch, calls, get count() { return i; } };
}

const ok = (body = "{}", status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const noSleep = async () => {};

test("client: a clean 200 resolves and reports status", async () => {
  const f = scriptedFetch([() => ok('{"hello":"world"}')]);
  const client = new ResilientClient({ fetchImpl: f.impl, retry: { sleep: noSleep } });
  const res = await client.request("https://api.test/v1/things");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).hello, "world");
});

test("client: retries a 500 and succeeds, and the caller sees only success", async () => {
  const f = scriptedFetch([() => ok("err", 500), () => ok("err", 502), () => ok('{"ok":true}')]);
  const client = new ResilientClient({
    fetchImpl: f.impl,
    retry: { sleep: noSleep, random: () => 0 },
  });
  const data = await client.getJson<{ ok: boolean }>("https://api.test/v1/x");
  assert.equal(data.ok, true);
  assert.equal(f.count, 3, "two failures then success");
});

test("client: a 429 raises RateLimitError and honours Retry-After", async () => {
  const delays: number[] = [];
  let n = 0;
  const impl = async () => {
    n++;
    if (n === 1) {
      return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
    }
    return ok('{"ok":1}');
  };
  const client = new ResilientClient({
    fetchImpl: impl as unknown as typeof fetch,
    retry: { sleep: async (ms) => { delays.push(ms); }, maxAttempts: 3 },
  });
  await client.getJson("https://api.test/v1/y");
  assert.deepEqual(delays, [3_000], "must sleep exactly the Retry-After window");
});

test("client: a 404 fails immediately without retrying", async () => {
  const f = scriptedFetch([() => ok("nope", 404)]);
  const client = new ResilientClient({ fetchImpl: f.impl, retry: { sleep: noSleep } });
  await assert.rejects(
    () => client.request("https://api.test/missing"),
    (e: unknown) => e instanceof HttpStatusError && e.status === 404,
  );
  assert.equal(f.count, 1);
});

test("client: after repeated failures the breaker opens and fails fast", async () => {
  const f = scriptedFetch([() => ok("down", 500)]);
  const client = new ResilientClient({
    fetchImpl: f.impl,
    retry: { sleep: noSleep, maxAttempts: 2, random: () => 0 },
    circuit: { failureThreshold: 1 },
  });
  await assert.rejects(() => client.request("https://api.test/a"));
  const countAfterFirst = f.count;
  await assert.rejects(
    () => client.request("https://api.test/a"),
    (e: unknown) => e instanceof CircuitOpenError,
  );
  assert.equal(f.count, countAfterFirst, "no further upstream calls once the circuit is open");
});

test("client: the rate limiter gates calls before they reach fetch", async () => {
  const f = scriptedFetch([() => ok()]);
  const waits: number[] = [];
  let t = 0;
  const client = new ResilientClient({
    fetchImpl: f.impl,
    rateLimiter: {
      ratePerSecond: 1,
      burst: 1,
      now: () => t,
      sleep: async (ms) => { waits.push(ms); t += ms; },
    },
  });
  await client.request("https://api.test/1");
  await client.request("https://api.test/2");
  assert.equal(waits.length, 1, "the second call had to wait for a token");
   assert.equal(f.count, 2);
});

test("client: onRequest receives observability events", async () => {
  const events: unknown[] = [];
  const f = scriptedFetch([() => ok(), () => ok("bad", 500)]);
  const client = new ResilientClient({
    fetchImpl: f.impl,
    retry: { sleep: noSleep, maxAttempts: 1 },
    onRequest: (e) => events.push(e),
  });
  await client.request("https://api.test/ok");
  await assert.rejects(() => client.request("https://api.test/fail"));
  assert.equal(events.length, 2);
  const first = events[0] as { status: number };
  const second = events[1] as { status: number | null };
  assert.equal(first.status, 200);
  assert.equal(second.status, null, "a failed attempt reports a null status with the error");
});

test("client: injects extra headers on every request", async () => {
  let seen: Record<string, string> = {};
  const impl = async (_u: unknown, init?: RequestInit) => {
    seen = init?.headers as Record<string, string>;
    return ok();
  };
  const client = new ResilientClient({
    fetchImpl: impl as unknown as typeof fetch,
    headers: { authorization: "Bearer token123" },
  });
  await client.request("https://api.test/z");
  assert.equal(seen.authorization, "Bearer token123");
});

test("client: snapshot exposes breaker and limiter state", async () => {
  const f = scriptedFetch([() => ok()]);
  const client = new ResilientClient({ fetchImpl: f.impl, rateLimiter: { ratePerSecond: 5 } });
  await client.request("https://api.test/s");
  const snap = client.snapshot();
  assert.equal(snap.circuit.state, "closed");
  assert.ok(snap.tokens <= 5);
});
