import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signDarazRequest } from './sign.js';

// Known-answer vector, computed independently with a one-off script
// implementing the spec (path prefix + sorted key+value concat + HMAC-SHA256):
//   node -e "const c=require('crypto');const p={app_key:'123456',timestamp:'1700000000000',
//     sign_method:'sha256',access_token:'test-token'};const ks=Object.keys(p).sort();
//     let s='/orders/get';for(const k of ks)s+=k+p[k];
//     console.log(c.createHmac('sha256','test-app-secret').update(s).digest('hex').toUpperCase())"
const EXPECTED = '2BF61AEBAAD6576E52A7F5A838DF211E2A0B6C7CC95FE1938A20A86AA0CFCA41';
const PARAMS = {
  app_key: '123456',
  timestamp: '1700000000000',
  sign_method: 'sha256',
  access_token: 'test-token',
};

test('known-answer: sign matches hardcoded uppercase hex', () => {
  assert.equal(signDarazRequest('/orders/get', PARAMS, 'test-app-secret'), EXPECTED);
});

test('insertion order does not change the signature', () => {
  const reordered: Record<string, string> = {};
  reordered.access_token = 'test-token';
  reordered.sign_method = 'sha256';
  reordered.timestamp = '1700000000000';
  reordered.app_key = '123456';
  assert.equal(signDarazRequest('/orders/get', reordered, 'test-app-secret'), EXPECTED);
});

test("'sign' param itself is excluded from the string-to-sign", () => {
  const withSign = { ...PARAMS, sign: 'DEADBEEF'.repeat(8) };
  assert.equal(signDarazRequest('/orders/get', withSign, 'test-app-secret'), EXPECTED);
});

test('api path prefix and secret both affect the signature', () => {
  assert.notEqual(signDarazRequest('/orders/items/get', PARAMS, 'test-app-secret'), EXPECTED);
  assert.notEqual(signDarazRequest('/orders/get', PARAMS, 'other-secret'), EXPECTED);
  assert.match(signDarazRequest('/orders/get', PARAMS, 'test-app-secret'), /^[0-9A-F]{64}$/);
});
