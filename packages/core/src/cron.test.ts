import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CronError, nextCronRun, parseCron, validateCron } from './cron.js';

describe('parseCron / validateCron', () => {
  it('accepts valid expressions', () => {
    for (const expr of [
      '* * * * *',
      '*/15 * * * *',
      '0 9 * * 1-5',
      '30 14 1 * *',
      '0 0 29 2 *',
      '0 9 * jan mon',
      '0,30 8-18/2 * * *',
    ]) {
      assert.doesNotThrow(() => validateCron(expr), expr);
    }
  });

  it('rejects invalid expressions with CronError', () => {
    for (const expr of [
      '61 * * * *', // minute out of range
      '* * * *', // too few fields
      '* * * * * *', // too many fields
      '0 0 32 * *', // day-of-month out of range
      '0 24 * * *', // hour out of range
      '*/0 * * * *', // zero step
      'a b c d e', // garbage
      '5-1 * * * *', // reversed range
      '',
    ]) {
      assert.throws(() => validateCron(expr), CronError, expr);
    }
  });

  it('parses fields into value sets', () => {
    const parsed = parseCron('*/15 9 * * *');
    assert.deepEqual([...parsed.minute!].sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.deepEqual([...parsed.hour!], [9]);
    assert.equal(parsed.dayOfMonth, null);
  });
});

describe('nextCronRun', () => {
  it('computes the next quarter hour for */15', () => {
    const from = new Date('2026-01-01T00:07:30.000Z');
    assert.equal(
      nextCronRun('*/15 * * * *', from).toISOString(),
      '2026-01-01T00:15:00.000Z',
    );
  });

  it('rolls to the next day when the time has passed', () => {
    const from = new Date('2026-01-01T10:00:00.000Z');
    assert.equal(
      nextCronRun('0 9 * * *', from).toISOString(),
      '2026-01-02T09:00:00.000Z',
    );
  });

  it('honours day-of-week (Monday)', () => {
    // 2026-01-02 is a Friday; next Monday 09:00 is 2026-01-05.
    const from = new Date('2026-01-02T12:00:00.000Z');
    assert.equal(
      nextCronRun('0 9 * * 1', from).toISOString(),
      '2026-01-05T09:00:00.000Z',
    );
  });

  it('honours day-of-month across months', () => {
    const from = new Date('2026-01-15T00:00:00.000Z');
    assert.equal(
      nextCronRun('30 14 1 * *', from).toISOString(),
      '2026-02-01T14:30:00.000Z',
    );
  });

  it('finds Feb 29 on leap years', () => {
    const from = new Date('2025-03-01T00:00:00.000Z');
    assert.equal(
      nextCronRun('0 0 29 2 *', from).toISOString(),
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('treats 0 and 7 as Sunday', () => {
    // 2026-01-03 is a Saturday; next Sunday is 2026-01-04.
    const from = new Date('2026-01-03T12:00:00.000Z');
    assert.equal(
      nextCronRun('0 8 * * 7', from).toISOString(),
      '2026-01-04T08:00:00.000Z',
    );
    assert.equal(
      nextCronRun('0 8 * * 0', from).toISOString(),
      '2026-01-04T08:00:00.000Z',
    );
  });

  it('is strictly after the from time', () => {
    const from = new Date('2026-01-01T09:00:00.000Z');
    const next = nextCronRun('0 9 * * *', from);
    assert.ok(next.getTime() > from.getTime());
    assert.equal(next.toISOString(), '2026-01-02T09:00:00.000Z');
  });
});
