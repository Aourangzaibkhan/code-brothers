import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyShopifyWebhook, computeShopifyWebhookHmac } from './webhook.js';

// Known-answer vector, computed independently with:
//   node -e "console.log(require('crypto').createHmac('sha256','shpss_test_secret_12345')
//     .update('{\"id\":12345,\"topic\":\"orders/create\",\"email\":\"test@example.com\"}','utf8').digest('base64'))"
const SECRET = 'shpss_test_secret_12345';
const BODY = '{"id":12345,"topic":"orders/create","email":"test@example.com"}';
const EXPECTED_BASE64 = 'wxe32YfzyPp3NrOu9XLUru0sKpO0qNT89YQvP+f4//s=';

test('known-answer: compute matches hardcoded base64 digest', () => {
  assert.equal(computeShopifyWebhookHmac(BODY, SECRET), EXPECTED_BASE64);
});

test('verify returns true for the known vector (string and Buffer bodies)', () => {
  assert.equal(verifyShopifyWebhook(BODY, EXPECTED_BASE64, SECRET), true);
  assert.equal(verifyShopifyWebhook(Buffer.from(BODY, 'utf8'), EXPECTED_BASE64, SECRET), true);
});

test('verify returns false for a tampered body', () => {
  assert.equal(verifyShopifyWebhook(BODY.replace('12345', '99999'), EXPECTED_BASE64, SECRET), false);
});

test('verify returns false for a tampered / wrong-length header and wrong secret', () => {
  assert.equal(verifyShopifyWebhook(BODY, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY, 'short', SECRET), false);
  assert.equal(verifyShopifyWebhook(BODY, EXPECTED_BASE64, 'other-secret'), false);
  assert.equal(verifyShopifyWebhook(BODY, '', SECRET), false);
});
