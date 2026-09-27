/**
 * Webhook signature verification with replay protection.
 *
 * Receiving a webhook is easy; trusting it is not. The three failures this
 * guards against:
 *   1. Forged payloads — anyone who knows the URL can POST to it.
 *   2. Replay — a valid, captured request re-sent later.
 *   3. Truncation/tampering — body modified in transit.
 *
 * Signature is HMAC-SHA256 over `${timestamp}.${rawBody}` in constant time.
 * The timestamp is bound into the signed material precisely so that a captured
 * request cannot be replayed outside the tolerance window.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureVerificationError } from "../core/errors.js";

export interface VerifyOptions {
  /** Shared secret configured with the provider. */
  secret: string;
  /** Tolerance for the timestamp, in seconds. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface ParsedSignatureHeader {
  timestamp: number;
  signature: string;
}

/**
 * Parse a `t=<unix>,v1=<hex>` style header. Providers differ in detail but this
 * shape (Stripe, GitHub, Slack, Enode-style) is the common denominator.
 */
export function parseSignatureHeader(header: string): ParsedSignatureHeader {
  const parts = header.split(",").reduce<Record<string, string>>((acc, chunk) => {
    const idx = chunk.indexOf("=");
    if (idx === -1) return acc;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    if (key) acc[key] = value;
    return acc;
  }, {});

  const rawTs = parts["t"] ?? parts["timestamp"];
  const signature = parts["v1"] ?? parts["sha256"] ?? parts["signature"];
  if (!rawTs || !signature) {
    throw new SignatureVerificationError("header missing timestamp or signature component");
  }
  const timestamp = Number(rawTs);
  if (!Number.isFinite(timestamp)) {
    throw new SignatureVerificationError("timestamp is not numeric");
  }
  return { timestamp, signature };
}

/** Compute the expected hex digest for a timestamp + raw body. */
export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * Verify a webhook. `rawBody` MUST be the exact bytes received — parsing to an
 * object and re-serialising changes whitespace and key order and will fail.
 */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  options: VerifyOptions,
): void {
  if (!signatureHeader) {
    throw new SignatureVerificationError("no signature header present");
  }
  const { timestamp, signature } = parseSignatureHeader(signatureHeader);

  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  const skew = Math.abs(nowSeconds - timestamp);
  if (skew > tolerance) {
    throw new SignatureVerificationError(
      `timestamp outside tolerance (${skew}s > ${tolerance}s) — possible replay`,
    );
  }

  const expected = computeSignature(options.secret, timestamp, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on length mismatch, so guard first. A length
  // mismatch is itself a verification failure, not an internal error.
  if (a.length !== b.length) {
    throw new SignatureVerificationError("signature length mismatch");
  }
  if (!timingSafeEqual(a, b)) {
    throw new SignatureVerificationError("signature does not match");
  }
}

/**
 * In-memory replay guard for event ids, so a correctly-signed but duplicated
 * delivery is not processed twice. Bounded by TTL to avoid unbounded growth.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true the first time an id is seen; false on a repeat. */
  check(eventId: string): boolean {
    this.prune();
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, this.now());
    return true;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
