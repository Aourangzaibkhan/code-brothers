import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommentEvents, verifyWebhookSignature } from './webhook.js';

// Known-answer vector, computed independently with:
//   node -e "require('crypto').createHmac('sha256','test-app-secret')
//     .update('{\"object\":\"instagram\",\"entry\":[{\"id\":\"123\",\"changes\":[]}]}').digest('hex')"
const KNOWN_BODY = '{"object":"instagram","entry":[{"id":"123","changes":[]}]}';
const KNOWN_SECRET = 'test-app-secret';
const KNOWN_HEX = 'dd001ef402a36d147259c603f8dd043f012c30a12f682643df7665890a0b005b';

test('verifyWebhookSignature accepts the known-answer vector', () => {
  assert.equal(verifyWebhookSignature(KNOWN_BODY, `sha256=${KNOWN_HEX}`, KNOWN_SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.from(KNOWN_BODY), `sha256=${KNOWN_HEX}`, KNOWN_SECRET), true);
});

test('verifyWebhookSignature rejects tampered body, signature and wrong secret', () => {
  assert.equal(verifyWebhookSignature(KNOWN_BODY + ' ', `sha256=${KNOWN_HEX}`, KNOWN_SECRET), false);
  const flipped = (KNOWN_HEX.startsWith('0') ? '1' : '0') + KNOWN_HEX.slice(1);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, `sha256=${flipped}`, KNOWN_SECRET), false);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, `sha256=${KNOWN_HEX}`, 'other-secret'), false);
});

test('verifyWebhookSignature rejects malformed headers', () => {
  assert.equal(verifyWebhookSignature(KNOWN_BODY, undefined, KNOWN_SECRET), false);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, null, KNOWN_SECRET), false);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, KNOWN_HEX, KNOWN_SECRET), false);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, 'sha256=not-hex', KNOWN_SECRET), false);
  assert.equal(verifyWebhookSignature(KNOWN_BODY, 'sha1=abcd', KNOWN_SECRET), false);
});

test('parseCommentEvents normalises comment changes and ignores other fields', () => {
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'entry-1',
        time: 1700000000,
        changes: [
          {
            field: 'comments',
            value: {
              id: 'comment-1',
              text: 'Great post!',
              from: { id: 'user-1', username: 'alice' },
              media: { id: 'media-1', media_product_type: 'FEED' },
            },
          },
          { field: 'mentions', value: { media_id: 'media-9', comment_id: 'c-x' } },
          {
            field: 'comments',
            value: {
              id: 'comment-2',
              text: 'Second',
              from: { id: 'user-2', username: 'bob' },
              media: { id: 'media-1' },
            },
          },
        ],
      },
      {
        id: 'entry-2',
        time: 1700000100,
        changes: [
          {
            field: 'comments',
            value: { id: 'comment-3', text: 'Yo', from: { id: 'user-3' }, media: { id: 'media-2' } },
          },
        ],
      },
    ],
  };
  const events = parseCommentEvents(payload);
  assert.deepEqual(events, [
    {
      entryId: 'entry-1',
      mediaId: 'media-1',
      commentId: 'comment-1',
      fromId: 'user-1',
      fromUsername: 'alice',
      text: 'Great post!',
      timestamp: 1700000000,
    },
    {
      entryId: 'entry-1',
      mediaId: 'media-1',
      commentId: 'comment-2',
      fromId: 'user-2',
      fromUsername: 'bob',
      text: 'Second',
      timestamp: 1700000000,
    },
    {
      entryId: 'entry-2',
      mediaId: 'media-2',
      commentId: 'comment-3',
      fromId: 'user-3',
      fromUsername: undefined,
      text: 'Yo',
      timestamp: 1700000100,
    },
  ]);
});

test('parseCommentEvents returns [] for garbage payloads', () => {
  assert.deepEqual(parseCommentEvents(null), []);
  assert.deepEqual(parseCommentEvents('nope'), []);
  assert.deepEqual(parseCommentEvents({}), []);
  assert.deepEqual(parseCommentEvents({ entry: 'x' }), []);
});
