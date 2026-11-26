/**
 * Webhook signature check.
 * The sender puts HMAC-SHA256(secret, raw body) as hex in the X-Signature header.
 * We compute the same value and compare in constant time.
 */

import crypto from "node:crypto";

export function sign(secret: string, body: Buffer | string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function isValidSignature(secret: string, body: Buffer | string, signature: string | undefined | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(signature);
  // timingSafeEqual throws on different lengths; a different length is simply wrong.
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
