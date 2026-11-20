import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redact, redactString } from './redact.js';

test('redact replaces values of sensitive keys, keeps safe values', () => {
  const out = redact({
    username: 'aurangzaib',
    password: 'hunter2',
    nested: { apiKey: 'abc123', note: 'hello' },
    list: [{ token: 'xyz' }, { ok: 1 }],
  });
  assert.equal(out.username, 'aurangzaib');
  assert.equal(out.password, REDACTED);
  assert.equal(out.nested.apiKey, REDACTED);
  assert.equal(out.nested.note, 'hello');
  assert.equal((out.list[0] as { token: string }).token, REDACTED);
  assert.equal((out.list[1] as { ok: number }).ok, 1);
});

test('redact is case/format insensitive about key names', () => {
  const out = redact({
    'API_KEY': 'k',
    'Access-Token': 't',
    client_secret: 's',
    Authorization: 'Bearer abc',
    'Set-Cookie': 'sid=1',
    refreshToken: 'r',
    CB_MASTER_KEY: 'm',
    normal: 'visible',
  });
  for (const key of Object.keys(out)) {
    if (key !== 'normal') assert.equal((out as Record<string, unknown>)[key], REDACTED, key);
  }
  assert.equal(out.normal, 'visible');
});

test('redact does not mutate the input', () => {
  const input = { password: 'hunter2', deep: { secret: 's' } };
  const out = redact(input);
  assert.equal(input.password, 'hunter2');
  assert.equal(input.deep.secret, 's');
  assert.notEqual(out, input);
  assert.notEqual(out.deep, input.deep);
});

test('redact scrubs token patterns inside plain string values', () => {
  const out = redact({ log: 'Authorization: Bearer abcdef1234567890 end' });
  assert.ok(!out.log.includes('abcdef1234567890'));
  assert.ok(out.log.includes(REDACTED));
});

test('redactString scrubs Bearer and Basic credentials', () => {
  assert.equal(
    redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'),
    `Authorization: Bearer ${REDACTED}`,
  );
  assert.ok(!redactString('auth Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'));
});

test('redactString scrubs JWTs, GitHub, OpenAI, AWS and Google keys', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.ok(!redactString(`token is ${jwt} ok`).includes(jwt));
  assert.ok(!redactString('ghp_1234567890abcdefghij1234567890abcd').includes('ghp_'));
  assert.ok(!redactString('key sk-ant-abcdefghijklmnopqrstuvwx').includes('sk-ant-'));
  assert.ok(!redactString('aws AKIAIOSFODNN7EXAMPLE here').includes('AKIAIOSFODNN7EXAMPLE'));
  const google = `AIza${'a'.repeat(35)}`;
  assert.ok(!redactString(`g ${google}`).includes(google));
});

test('redactString scrubs key=value pairs and URL credentials', () => {
  const out = redactString('connecting password=hunter2 to db');
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes(`password=${REDACTED}`));
  const url = redactString('postgres://admin:s3cr3tpw@db.internal:5432/app');
  assert.ok(!url.includes('s3cr3tpw'));
  assert.ok(url.includes('db.internal'));
});

test('redactString leaves ordinary text untouched', () => {
  const s = 'Order #1234 shipped to Karachi, total Rs 5,600';
  assert.equal(redactString(s), s);
});

test('redact handles primitives, arrays, dates and circular refs', () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact('password=abc'), `password=${REDACTED}`);
  assert.deepEqual(redact(['a', 'b']), ['a', 'b']);
  const d = new Date(0);
  const outDate = redact({ at: d });
  assert.ok(outDate.at instanceof Date);
  assert.equal(outDate.at.getTime(), 0);
  const circular: Record<string, unknown> = { name: 'x' };
  circular.self = circular;
  const outCircular = redact(circular);
  assert.equal(outCircular.self, '[Circular]');
});

test('redact scrubs Error message and stack', () => {
  const err = new Error('login failed for password=hunter2');
  const out = redact(err);
  assert.ok(out instanceof Error);
  assert.ok(!out.message.includes('hunter2'));
});

test('redact supports custom replacement and extra keys', () => {
  const out = redact({ session_pin_code: '9988', password: 'x' }, { extraKeys: ['session_pin_code'] });
  assert.equal(out.session_pin_code, REDACTED);
  const out2 = redact({ password: 'x' }, { replacement: '***' });
  assert.equal(out2.password, '***');
});
