import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyWebhook,
  computeSignature,
  parseSignatureHeader,
  ReplayGuard,
  SignatureVerificationError,
} from "../dist/index.js";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ event: "device.connected", id: "evt_1" });

function header(tsSeconds: number, body = BODY, secret = SECRET): string {
  return `t=${tsSeconds},v1=${computeSignature(secret, tsSeconds, body)}`;
}

const now = 1_700_000_000_000;
const nowSeconds = Math.floor(now / 1000);

test("webhook: accepts a correctly signed payload", () => {
  assert.doesNotThrow(() =>
    verifyWebhook(BODY, header(nowSeconds), { secret: SECRET, now: () => now }),
  );
});

test("webhook: rejects a missing signature header", () => {
  assert.throws(
    () => verifyWebhook(BODY, undefined, { secret: SECRET, now: () => now }),
    (e: unknown) => e instanceof SignatureVerificationError,
  );
});

test("webhook: rejects a tampered body even with a valid-looking header", () => {
  const signed = header(nowSeconds);
  const tampered = JSON.stringify({ event: "device.connected", id: "evt_EVIL" });
  assert.throws(
    () => verifyWebhook(tampered, signed, { secret: SECRET, now: () => now }),
    (e: unknown) => e instanceof SignatureVerificationError && /does not match/.test(e.message),
  );
});

test("webhook: rejects the wrong secret", () => {
  assert.throws(
    () => verifyWebhook(BODY, header(nowSeconds, BODY, "wrong_secret"), {
      secret: SECRET,
      now: () => now,
    }),
    (e: unknown) => e instanceof SignatureVerificationError,
  );
});

test("webhook: rejects a replayed old timestamp (replay protection)", () => {
  const old = nowSeconds - 3_600; // an hour ago, outside the 5-minute tolerance
  assert.throws(
    () => verifyWebhook(BODY, header(old), { secret: SECRET, now: () => now }),
    (e: unknown) => e instanceof SignatureVerificationError && /replay/.test(e.message),
  );
});

test("webhook: tolerance is configurable", () => {
  const ts = nowSeconds - 3_600;
  assert.doesNotThrow(() =>
    verifyWebhook(BODY, header(ts), {
      secret: SECRET,
      now: () => now,
      toleranceSeconds: 7_200,
    }),
  );
});

test("webhook: rejects a malformed header", () => {
  assert.throws(
    () => verifyWebhook(BODY, "nonsense", { secret: SECRET, now: () => now }),
    (e: unknown) => e instanceof SignatureVerificationError,
  );
});

test("parseSignatureHeader: extracts timestamp and signature", () => {
  const parsed = parseSignatureHeader("t=123,v1=abc");
  assert.deepEqual(parsed, { timestamp: 123, signature: "abc" });
  // common alternative naming
  assert.deepEqual(parseSignatureHeader("timestamp=5,sha256=deadbeef"), {
    timestamp: 5,
    signature: "deadbeef",
  });
});

test("ReplayGuard: first sighting passes, duplicates are rejected", () => {
  const guard = new ReplayGuard(60_000, () => now);
  assert.equal(guard.check("evt_1"), true);
  assert.equal(guard.check("evt_1"), false, "a duplicate delivery must be rejected");
  assert.equal(guard.check("evt_2"), true);
});

test("ReplayGuard: entries expire after the TTL", () => {
  let t = now;
  const guard = new ReplayGuard(1_000, () => t);
  assert.equal(guard.check("evt_1"), true);
  assert.equal(guard.check("evt_1"), false);
  t += 1_001;
  assert.equal(guard.check("evt_1"), true, "after the TTL the id is forgotten");
});
