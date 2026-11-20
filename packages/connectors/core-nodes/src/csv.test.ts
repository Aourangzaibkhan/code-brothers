import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestNodeContext } from '@code-brothers/node-sdk';
import { parseCsv, rowsToObjects, stringifyCsv } from './csv.js';
import { csvTransformNode } from './nodes.js';

describe('parseCsv — real CSV rules', () => {
  it('handles quoted fields, embedded commas/newlines and escaped quotes', () => {
    const text =
      'name,note,count\r\n' +
      '"Ada, A.","line one\nline two",3\r\n' +
      '"Bob ""The Builder""",plain,4';
    assert.deepEqual(parseCsv(text), [
      ['name', 'note', 'count'],
      ['Ada, A.', 'line one\nline two', '3'],
      ['Bob "The Builder"', 'plain', '4'],
    ]);
  });

  it('accepts LF endings and does not invent a row after a trailing newline', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('single'), [['single']]);
  });
});

describe('stringifyCsv + round-trip', () => {
  it('quotes only when needed and round-trips through parseCsv', () => {
    const rows: unknown[][] = [
      ['name', 'note', 'count'],
      ['Ada, A.', 'line one\nline two', 3],
      ['Bob "The Builder"', 'plain', 4],
      ['empty', '', null],
    ];
    const text = stringifyCsv(rows);
    assert.ok(text.includes('"Ada, A."'));
    assert.ok(text.includes('"Bob ""The Builder"""'));
    const roundTripped = parseCsv(text);
    assert.deepEqual(roundTripped, [
      ['name', 'note', 'count'],
      ['Ada, A.', 'line one\nline two', '3'],
      ['Bob "The Builder"', 'plain', '4'],
      ['empty', '', ''],
    ]);
    // parse -> stringify -> parse is stable.
    assert.deepEqual(parseCsv(stringifyCsv(roundTripped)), roundTripped);
  });
});

describe('rowsToObjects', () => {
  it('uses the first row as the header', () => {
    assert.deepEqual(
      rowsToObjects([
        ['id', 'city'],
        ['1', 'Lahore'],
        ['2'],
      ]),
      [
        { id: '1', city: 'Lahore' },
        { id: '2', city: '' },
      ],
    );
  });
});

describe('csvTransform node', () => {
  it('outputs one item per data row and renames columns via the mapping', async () => {
    const { ctx } = createTestNodeContext({
      parameters: {
        columnMappingJson: '{"full_name":"name","town":"city"}',
      },
    });
    const [out] = await csvTransformNode.execute(ctx, [
      { json: { csv: 'full_name,town\nAda,Lahore\nGrace,Karachi' } },
      { json: { csv: 'full_name,town\nEdsger,Amsterdam' } },
    ]);
    assert.deepEqual(
      out?.map((i) => i.json),
      [
        { name: 'Ada', city: 'Lahore' },
        { name: 'Grace', city: 'Karachi' },
        { name: 'Edsger', city: 'Amsterdam' },
      ],
    );
  });

  it('works without a mapping and throws when an item has no csv field', async () => {
    const { ctx } = createTestNodeContext({ parameters: {} });
    const [out] = await csvTransformNode.execute(ctx, [
      { json: { csv: 'a,b\n1,2' } },
    ]);
    assert.deepEqual(out?.[0]?.json, { a: '1', b: '2' });

    const { ctx: badCtx } = createTestNodeContext({ parameters: {} });
    await assert.rejects(
      () => csvTransformNode.execute(badCtx, [{ json: { nope: 1 } }]),
      /"csv" field/,
    );
  });
});
