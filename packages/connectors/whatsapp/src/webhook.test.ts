import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWebhookEvents,
  verifyWebhookChallenge,
  verifyWebhookSignature,
} from './webhook.js';

// Known-answer vector, computed independently with node:crypto:
// createHmac('sha256', 'test-app-secret').update(BODY).digest('hex')
const SECRET = 'test-app-secret';
const BODY = '{"object":"whatsapp_business_account","entry":[]}';
const EXPECTED_HEX =
  'c84a394cc475525991e78ff16e430b02e47f953877d2af0ade26956ce6f384dc';

test('signature verification accepts the known-answer vector', () => {
  assert.equal(
    verifyWebhookSignature(BODY, `sha256=${EXPECTED_HEX}`, SECRET),
    true,
  );
  // Buffer body + bare hex header also work.
  assert.equal(
    verifyWebhookSignature(Buffer.from(BODY), EXPECTED_HEX, SECRET),
    true,
  );
});

test('signature verification rejects tampered body, secret and header', () => {
  assert.equal(
    verifyWebhookSignature(`${BODY} `, `sha256=${EXPECTED_HEX}`, SECRET),
    false,
  );
  assert.equal(
    verifyWebhookSignature(BODY, `sha256=${EXPECTED_HEX}`, 'wrong-secret'),
    false,
  );
  assert.equal(
    verifyWebhookSignature(BODY, 'sha256=deadbeef', SECRET),
    false,
  );
  assert.equal(verifyWebhookSignature(BODY, undefined, SECRET), false);
});

test('GET challenge echoes only on mode+token match', () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': 'my-verify-token',
    'hub.challenge': '1158201444',
  };
  assert.equal(verifyWebhookChallenge(query, 'my-verify-token'), '1158201444');
  assert.equal(verifyWebhookChallenge(query, 'other-token'), null);
  assert.equal(
    verifyWebhookChallenge({ ...query, 'hub.mode': 'unsubscribe' }, 'my-verify-token'),
    null,
  );
});

const SAMPLE_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA123',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'PN123', display_phone_number: '15550001' },
            contacts: [{ wa_id: '923001234567', profile: { name: 'Ali Raza' } }],
            messages: [
              {
                id: 'wamid.ABC',
                from: '923001234567',
                timestamp: '1768478400',
                type: 'text',
                text: { body: 'Salam, price kya hai?' },
              },
              {
                id: 'wamid.DEF',
                from: '923001234567',
                timestamp: '1768478405',
                type: 'image',
                image: { id: 'MEDIA42', caption: 'payment screenshot', mime_type: 'image/jpeg' },
              },
              {
                id: 'wamid.GHI',
                from: '923001234567',
                timestamp: '1768478410',
                type: 'location',
                location: { latitude: 31.52, longitude: 74.35, name: 'Lahore' },
              },
            ],
            statuses: [
              {
                id: 'wamid.XYZ',
                recipient_id: '923001234567',
                status: 'read',
                timestamp: '1768478500',
              },
            ],
          },
        },
      ],
    },
  ],
};

test('parses messages and statuses into normalized events', () => {
  const events = parseWebhookEvents(SAMPLE_PAYLOAD);
  assert.equal(events.length, 4);

  const text = events[0]!;
  assert.equal(text.kind, 'message');
  if (text.kind === 'message') {
    assert.equal(text.messageId, 'wamid.ABC');
    assert.equal(text.from, '923001234567');
    assert.equal(text.senderName, 'Ali Raza');
    assert.equal(text.type, 'text');
    assert.equal(text.text, 'Salam, price kya hai?');
    assert.equal(text.timestamp, 1768478400);
    assert.equal(text.phoneNumberId, 'PN123');
  }

  const image = events[1]!;
  assert.equal(image.kind, 'message');
  if (image.kind === 'message') {
    assert.equal(image.type, 'image');
    assert.equal(image.mediaId, 'MEDIA42');
    assert.equal(image.caption, 'payment screenshot');
  }

  const location = events[2]!;
  assert.equal(location.kind, 'message');
  if (location.kind === 'message') {
    assert.deepEqual(location.location, {
      latitude: 31.52,
      longitude: 74.35,
      name: 'Lahore',
      address: undefined,
    });
  }

  const status = events[3]!;
  assert.equal(status.kind, 'status');
  if (status.kind === 'status') {
    assert.equal(status.messageId, 'wamid.XYZ');
    assert.equal(status.recipientId, '923001234567');
    assert.equal(status.status, 'read');
  }
});

test('garbage payloads parse to an empty list instead of throwing', () => {
  assert.deepEqual(parseWebhookEvents(null), []);
  assert.deepEqual(parseWebhookEvents('nope'), []);
  assert.deepEqual(parseWebhookEvents({ entry: 'x' }), []);
  assert.deepEqual(parseWebhookEvents({ entry: [{ changes: [{ field: 'other', value: {} }] }] }), []);
});
