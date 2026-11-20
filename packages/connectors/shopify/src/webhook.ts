import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook HMAC.
 *
 * Real algorithm: HMAC-SHA256 of the RAW request body keyed with the app
 * secret, digest encoded as BASE64, compared (timing-safe) with the value
 * Shopify sends in the `X-Shopify-Hmac-Sha256` header.
 */
export function verifyShopifyWebhook(
  rawBody: string | Buffer,
  hmacHeader: string,
  secret: string,
): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('base64');
  const expected = Buffer.from(digest, 'utf8');
  const actual = Buffer.from(hmacHeader, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Compute the expected header value (exported for tests / debugging). */
export function computeShopifyWebhookHmac(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('base64');
}
