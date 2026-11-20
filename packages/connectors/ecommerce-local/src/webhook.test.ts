import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WebhookEmitter,
  WebhookReceiver,
  WebhookVerificationError,
  buildWebhookHeaders,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhook.js';

// Known-answer vectors, computed independently with a one-off
// `node -e "crypto.createHmac('sha256', secret).update(body).digest('hex')"`
// and hardcoded here — the tests never derive them from the implementation.
const VECTOR_BODY_1 = 'hello webhook';
const VECTOR_SECRET_1 = 'test-secret';
const VECTOR_HEX_1 =
  '98cf4fff75577aa7e905df80eaea2f3bf25db82e14cf3e2a582d8399f2c5e68d';

const VECTOR_BODY_2 = '{"event":"order.created","data":{"id":42}}';
const VECTOR_SECRET_2 = 'whsec_test_secret';
const VECTOR_HEX_2 =
  '7d1c78d9fa4696fc8e52d0110fc321405ac2cc0b93b8d8165b69a2f253355f78';

describe('signWebhookPayload — known answers', () => {
  it('matches the hardcoded HMAC-SHA256 vectors', () => {
    assert.equal(signWebhookPayload(VECTOR_BODY_1, VECTOR_SECRET_1), VECTOR_HEX_1);
    assert.equal(signWebhookPayload(VECTOR_BODY_2, VECTOR_SECRET_2), VECTOR_HEX_2);
    assert.equal(
      signWebhookPayload(Buffer.from(VECTOR_BODY_1, 'utf8'), VECTOR_SECRET_1),
      VECTOR_HEX_1,
    );
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts sha256= prefixed and bare hex signatures', () => {
    assert.equal(
      verifyWebhookSignature(VECTOR_BODY_1, `sha256=${VECTOR_HEX_1}`, VECTOR_SECRET_1),
      true,
    );
    assert.equal(
      verifyWebhookSignature(VECTOR_BODY_1, VECTOR_HEX_1, VECTOR_SECRET_1),
      true,
    );
  });

  it('rejects tampered bodies, wrong secrets and malformed headers', () => {
    assert.equal(
      verifyWebhookSignature('hello webhook!', `sha256=${VECTOR_HEX_1}`, VECTOR_SECRET_1),
      false,
    );
    assert.equal(
      verifyWebhookSignature(VECTOR_BODY_1, `sha256=${VECTOR_HEX_1}`, 'other-secret'),
      false,
    );
    assert.equal(verifyWebhookSignature(VECTOR_BODY_1, 'sha256=zzzz', VECTOR_SECRET_1), false);
    assert.equal(verifyWebhookSignature(VECTOR_BODY_1, '', VECTOR_SECRET_1), false);
    assert.equal(verifyWebhookSignature(VECTOR_BODY_1, undefined, VECTOR_SECRET_1), false);
    assert.equal(verifyWebhookSignature(VECTOR_BODY_1, null, VECTOR_SECRET_1), false);
  });
});

describe('buildWebhookHeaders', () => {
  it('builds the three signed headers', () => {
    const headers = buildWebhookHeaders(
      'order.created',
      VECTOR_BODY_2,
      VECTOR_SECRET_2,
      1700000000000,
    );
    assert.equal(headers['X-CodeBrothers-Event'], 'order.created');
    assert.equal(headers['X-CodeBrothers-Timestamp'], '1700000000000');
    assert.equal(headers['X-CodeBrothers-Signature'], `sha256=${VECTOR_HEX_2}`);
  });
});

describe('WebhookEmitter', () => {
  it('POSTs a signed JSON envelope and returns status + body', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const stubFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response('{"ok":true}', { status: 202 });
    };
    const emitter = new WebhookEmitter({
      url: 'https://hooks.example.com/cb',
      secret: 'emitter-secret',
      fetch: stubFetch,
      source: 'test-suite',
    });
    const result = await emitter.emit('payment.received', { amount: 500 });
    assert.equal(result.status, 202);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(capturedUrl, 'https://hooks.example.com/cb');

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['X-CodeBrothers-Event'], 'payment.received');
    assert.equal(headers['X-CodeBrothers-Source'], 'test-suite');
    assert.equal(headers['Content-Type'], 'application/json');

    const rawBody = capturedInit?.body as string;
    const envelope = JSON.parse(rawBody) as {
      event: string;
      data: { amount: number };
      sentAt: string;
    };
    assert.equal(envelope.event, 'payment.received');
    assert.deepEqual(envelope.data, { amount: 500 });
    assert.ok(!Number.isNaN(Date.parse(envelope.sentAt)));
    // The signature header must verify against the exact bytes sent.
    assert.equal(
      verifyWebhookSignature(rawBody, headers['X-CodeBrothers-Signature'], 'emitter-secret'),
      true,
    );
  });

  it('throws on non-2xx responses', async () => {
    const emitter = new WebhookEmitter({
      url: 'https://hooks.example.com/cb',
      secret: 's',
      fetch: async () => new Response('nope', { status: 500 }),
    });
    await assert.rejects(() => emitter.emit('order.created', {}), /HTTP 500/);
  });
});

describe('WebhookReceiver', () => {
  const secret = 'receiver-secret';
  const receiver = new WebhookReceiver({ secret });

  function signedRequest(event: string, data: unknown) {
    const rawBody = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
    return { rawBody, headers: buildWebhookHeaders(event, rawBody, secret, 1) };
  }

  it('verifyAndParse returns event + data for a valid signature', () => {
    const { rawBody, headers } = signedRequest('lead.submitted', { email: 'a@b.c' });
    const parsed = receiver.verifyAndParse(rawBody, headers);
    assert.equal(parsed.event, 'lead.submitted');
    assert.deepEqual(parsed.data, { email: 'a@b.c' });
  });

  it('verifyAndParse throws WebhookVerificationError on tampering', () => {
    const { rawBody, headers } = signedRequest('order.created', { id: 1 });
    const tampered = rawBody.replace('"id":1', '"id":2');
    assert.throws(() => receiver.verifyAndParse(tampered, headers), WebhookVerificationError);
    assert.throws(
      () => receiver.verifyAndParse(rawBody, { 'x-codebrothers-signature': 'sha256=00' }),
      WebhookVerificationError,
    );
  });

  it('handle dispatches by event type and returns the handler result', async () => {
    const { rawBody, headers } = signedRequest('payment.received', { amount: 42 });
    const result = await receiver.handle(rawBody, headers, {
      'payment.received': async (data: { amount: number }) => `got:${data.amount}`,
      'order.created': async () => 'wrong handler',
    });
    assert.equal(result, 'got:42');
  });

  it('handle throws when no handler is registered for the event', async () => {
    const { rawBody, headers } = signedRequest('unknown.event', {});
    await assert.rejects(
      () => receiver.handle(rawBody, headers, {}),
      /No webhook handler/,
    );
  });
});
