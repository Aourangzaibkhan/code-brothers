import { createHmac } from 'node:crypto';

/**
 * Daraz / Lazada Open Platform request signing (real algorithm).
 *
 * stringToSign = apiPath + concat over all params except `sign`, sorted by
 * key in ascending byte order, of (key immediately followed by value) —
 * no separators, no `=` or `&`.
 * sign = HMAC-SHA256(stringToSign, appSecret), hex digest in UPPERCASE.
 */
export function signDarazRequest(
  apiPath: string,
  params: Record<string, string>,
  appSecret: string,
): string {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  let stringToSign = apiPath;
  for (const key of keys) stringToSign += key + params[key];
  return createHmac('sha256', appSecret).update(stringToSign, 'utf8').digest('hex').toUpperCase();
}
