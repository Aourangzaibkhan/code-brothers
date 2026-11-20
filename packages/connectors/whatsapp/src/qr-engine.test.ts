import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemorySessionStore,
  SimulatedQrEngine,
  type QrSessionState,
  type SessionCipher,
} from './qr-engine.js';
import { BaileysQrEngine } from './baileys-engine.js';

/** Reversible test cipher: proves engines never store plaintext. */
const testCipher: SessionCipher = {
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (blob) => {
    if (!blob.startsWith('enc:')) throw new Error('bad blob');
    return Buffer.from(blob.slice(4), 'base64').toString('utf8');
  },
};

function makeEngine(store = new MemorySessionStore()) {
  return {
    store,
    engine: new SimulatedQrEngine({
      sessionId: 'num-1',
      store,
      cipher: testCipher,
      phoneNumber: '923001234567',
      sleep: async () => {},
    }),
  };
}

test('full lifecycle: qr -> scan -> connected, session stored encrypted', async () => {
  const { store, engine } = makeEngine();
  const states: QrSessionState[] = [];
  const qrPayloads: string[] = [];
  engine.on('state', (s) => states.push(s));
  engine.on('qr', (qr) => qrPayloads.push(qr));

  assert.equal(engine.state, 'disconnected');
  await engine.connect();
  assert.equal(engine.state, 'qr');
  assert.equal(qrPayloads.length, 1);
  assert.match(qrPayloads[0]!, /^cb-sim-qr:num-1:/);

  await engine.simulateScan();
  assert.equal(engine.state, 'connected');
  assert.deepEqual(states, ['qr', 'connecting', 'connected']);
  assert.equal(engine.connectedPhoneNumber, '923001234567');

  // The stored blob must be ciphertext — no plaintext phone number in it.
  assert.equal(store.has('num-1'), true);
  const blob = await store.load('num-1');
  assert.ok(blob);
  assert.ok(!blob.includes('923001234567'));

  const sent = await engine.sendText('923009999999', 'Salam!');
  assert.equal(sent.messageId, 'sim-num-1-1');
});

test('stored session restores without a QR scan', async () => {
  const store = new MemorySessionStore();
  const first = makeEngine(store).engine;
  await first.connect();
  await first.simulateScan();
  await first.disconnect();
  assert.equal(first.state, 'disconnected');

  const second = new SimulatedQrEngine({
    sessionId: 'num-1',
    store,
    cipher: testCipher,
    sleep: async () => {},
  });
  let qrShown = false;
  second.on('qr', () => {
    qrShown = true;
  });
  await second.connect();
  assert.equal(second.state, 'connected');
  assert.equal(qrShown, false);
  assert.equal(second.connectedPhoneNumber, '923001234567');
});

test('logout wipes the stored session so the next connect needs a QR', async () => {
  const { store, engine } = makeEngine();
  await engine.connect();
  await engine.simulateScan();
  await engine.logout();
  assert.equal(engine.state, 'disconnected');
  assert.equal(store.has('num-1'), false);
  await engine.connect();
  assert.equal(engine.state, 'qr');
});

test('sendText and simulateScan enforce the state machine', async () => {
  const { engine } = makeEngine();
  await assert.rejects(engine.sendText('1', 'x'), /disconnected/);
  await assert.rejects(engine.simulateScan(), /requires the "qr" state/);
  await engine.connect(); // -> qr
  await assert.rejects(engine.sendText('1', 'x'), /"qr"/);
});

test('an undecryptable stored session is deleted and connect fails loudly', async () => {
  const store = new MemorySessionStore();
  await store.save('num-1', 'not-a-valid-blob');
  const engine = new SimulatedQrEngine({
    sessionId: 'num-1',
    store,
    cipher: testCipher,
    sleep: async () => {},
  });
  const errors: Error[] = [];
  engine.on('error', (e) => errors.push(e));
  await assert.rejects(engine.connect(), /unreadable/);
  assert.equal(store.has('num-1'), false);
  assert.equal(errors.length, 1);
  assert.equal(engine.state, 'disconnected');
});

test('Baileys engine implements the same contract without connecting', () => {
  const engine = new BaileysQrEngine({
    sessionId: 'num-9',
    store: new MemorySessionStore(),
    cipher: testCipher,
  });
  assert.equal(engine.sessionId, 'num-9');
  assert.equal(engine.state, 'disconnected');
  assert.equal(typeof engine.connect, 'function');
  assert.equal(typeof engine.on, 'function');
});

test('Baileys engine refuses to send while disconnected', async () => {
  const engine = new BaileysQrEngine({
    sessionId: 'num-9',
    store: new MemorySessionStore(),
    cipher: testCipher,
  });
  await assert.rejects(engine.sendText('923001234567', 'hi'), /disconnected/);
});
