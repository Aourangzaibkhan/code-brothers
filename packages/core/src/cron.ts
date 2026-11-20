/**
 * Minimal 5-field cron parser + next-run calculator.
 * Fields: minute hour day-of-month month day-of-week.
 * Supports `*`, values, ranges (`1-5`), steps (`* /15`, `1-10/2`) and
 * comma lists, plus month/weekday names (jan, mon, ...). Day-of-week
 * accepts 0-7 where both 0 and 7 mean Sunday. When both day-of-month and
 * day-of-week are restricted, the standard cron OR rule applies.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface ParsedCron {
  expression: string;
  /** Allowed values, or null for `*` (unrestricted). */
  minute: Set<number> | null;
  hour: Set<number> | null;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseValue(
  token: string,
  names: Record<string, number> | undefined,
  field: string,
): number {
  const named = names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new CronError(`Invalid value "${token}" in cron field "${field}"`);
  }
  return Number(token);
}

function parseField(
  raw: string,
  field: string,
  min: number,
  max: number,
  names?: Record<string, number>,
  normalize?: (value: number) => number,
): Set<number> | null {
  if (raw === '*') return null;
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0 || rangePart === undefined || rangePart === '') {
      throw new CronError(`Invalid cron field "${field}": "${raw}"`);
    }
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronError(
          `Invalid step "${stepPart}" in cron field "${field}"`,
        );
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      if (a === undefined || b === undefined || a === '' || b === '') {
        throw new CronError(`Invalid range "${rangePart}" in cron field "${field}"`);
      }
      lo = parseValue(a, names, field);
      hi = parseValue(b, names, field);
    } else {
      lo = parseValue(rangePart, names, field);
      hi = stepPart !== undefined ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronError(
        `Value out of range in cron field "${field}": "${part}" (allowed ${min}-${max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(normalize ? normalize(v) : v);
    }
  }
  return values;
}

/** Parse and validate a 5-field cron expression. Throws CronError. */
export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string') {
    throw new CronError('Cron expression must be a string');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expression}"`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    expression: expression.trim(),
    minute: parseField(minute, 'minute', 0, 59),
    hour: parseField(hour, 'hour', 0, 23),
    dayOfMonth: parseField(dom, 'day-of-month', 1, 31),
    month: parseField(month, 'month', 1, 12, MONTH_NAMES),
    dayOfWeek: parseField(dow, 'day-of-week', 0, 7, DOW_NAMES, (v) =>
      v === 7 ? 0 : v,
    ),
  };
}

/** Validate a cron expression. Throws CronError when invalid. */
export function validateCron(expression: string): void {
  parseCron(expression);
}

function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const domRestricted = parsed.dayOfMonth !== null;
  const dowRestricted = parsed.dayOfWeek !== null;
  const domOk =
    !domRestricted || parsed.dayOfMonth!.has(date.getDate());
  const dowOk =
    !dowRestricted || parsed.dayOfWeek!.has(date.getDay());
  if (domRestricted && dowRestricted) return domOk || dowOk; // cron OR rule
  return domOk && dowOk;
}

/**
 * Compute the next run time strictly after `from` (seconds/ms zeroed).
 * Throws CronError if no run exists within ~4 years.
 */
export function nextCronRun(
  expression: string | ParsedCron,
  from: Date = new Date(),
): Date {
  const parsed =
    typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = 4 * 366 * 24 * 60; // minutes in ~4 years
  for (let i = 0; i < limit; i++) {
    if (parsed.month !== null && !parsed.month.has(cursor.getMonth() + 1)) {
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(cursor.getMonth() + 1);
      continue;
    }
    if (!dayMatches(parsed, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (parsed.hour !== null && !parsed.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (parsed.minute !== null && !parsed.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    return new Date(cursor.getTime());
  }
  throw new CronError(
    `No run time found within 4 years for cron "${parsed.expression}"`,
  );
}
