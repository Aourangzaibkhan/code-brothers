import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SqlStoreConnector,
  buildInsert,
  buildSelect,
  buildUpdate,
  type Queryable,
} from './sql.js';

function fakeQueryable(rows: unknown[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queryable: Queryable = {
    async query(text, values) {
      calls.push({ text, values: values ?? [] });
      return { rows };
    },
  };
  return { queryable, calls };
}

describe('query builders', () => {
  it('buildSelect parameterizes where/order/limit', () => {
    const built = buildSelect('products', {
      where: { category: 'decor', in_stock: true },
      orderBy: { column: 'created_at', direction: 'DESC' },
      limit: 5,
    });
    assert.equal(
      built.text,
      'SELECT * FROM "products" WHERE "category" = $1 AND "in_stock" = $2 ORDER BY "created_at" DESC LIMIT $3',
    );
    assert.deepEqual(built.values, ['decor', true, 5]);
  });

  it('buildInsert and buildUpdate use placeholders + RETURNING *', () => {
    const insert = buildInsert('orders', { customer: 'Ada', total: 99 });
    assert.equal(
      insert.text,
      'INSERT INTO "orders" ("customer", "total") VALUES ($1, $2) RETURNING *',
    );
    assert.deepEqual(insert.values, ['Ada', 99]);

    const update = buildUpdate('orders', { status: 'paid' }, { id: 7 });
    assert.equal(
      update.text,
      'UPDATE "orders" SET "status" = $1 WHERE "id" = $2 RETURNING *',
    );
    assert.deepEqual(update.values, ['paid', 7]);
  });

  it('rejects invalid identifiers and unscoped updates', () => {
    assert.throws(() => buildSelect('users; DROP TABLE users'), /Invalid SQL identifier/);
    assert.throws(() => buildSelect('users', { where: { '1bad': 1 } }), /Invalid SQL identifier/);
    assert.throws(() => buildUpdate('users', { a: 1 }, {}), /non-empty where/);
    assert.throws(() => buildInsert('users', {}), /non-empty row/);
  });
});

describe('parameterization proof', () => {
  it('a malicious value never reaches the SQL text', async () => {
    const malicious = `x'; DROP TABLE users; --`;
    const built = buildSelect('users', { where: { name: malicious } });
    assert.ok(!built.text.includes('DROP TABLE'), 'text must not contain DROP TABLE');
    assert.ok(!built.text.includes(malicious), 'text must not contain the raw value');
    assert.equal(built.text, 'SELECT * FROM "users" WHERE "name" = $1');
    assert.equal(built.values[0], malicious);

    // And the same guarantee holds end-to-end through the connector,
    // captured by a fake queryable.
    const { queryable, calls } = fakeQueryable([{ id: 1 }]);
    const connector = new SqlStoreConnector({ queryable });
    const rows = await connector.select('users', { where: { name: malicious } });
    assert.equal(rows.length, 1);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]?.text.includes('DROP TABLE'));
    assert.ok(!calls[0]?.text.includes(malicious));
    assert.equal(calls[0]?.values[0], malicious);
  });
});

describe('SqlStoreConnector convenience methods', () => {
  it('select/insert/update run the built queries through the queryable', async () => {
    const { queryable, calls } = fakeQueryable([{ id: 3 }]);
    const connector = new SqlStoreConnector({ queryable });

    await connector.insert('orders', { customer: 'Ada' });
    assert.equal(calls[0]?.text, 'INSERT INTO "orders" ("customer") VALUES ($1) RETURNING *');
    assert.deepEqual(calls[0]?.values, ['Ada']);

    await connector.update('orders', { status: 'shipped' }, { id: 3 });
    assert.equal(calls[1]?.text, 'UPDATE "orders" SET "status" = $1 WHERE "id" = $2 RETURNING *');
    assert.deepEqual(calls[1]?.values, ['shipped', 3]);

    const { rows } = await connector.query('SELECT 1', []);
    assert.deepEqual(rows, [{ id: 3 }]);
  });

  it('requires a connectionString or a queryable', () => {
    assert.throws(() => new SqlStoreConnector({}), /connectionString.*queryable/);
  });
});
