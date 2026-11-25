import { Pool } from 'pg';

/**
 * Minimal SQL store connector over `pg`, with safe query builders.
 *
 * Safety model: identifiers (table / column names) are validated against a
 * strict pattern and double-quoted; **values are never interpolated into the
 * SQL text** — they always travel as `$1..$n` bound parameters.
 */

export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number }>;
}

export interface SqlStoreConnectorOptions {
  connectionString?: string;
  /** Any object with a pg-compatible `query` (tests, embedding, pools). */
  queryable?: Queryable;
}

export interface BuiltQuery {
  text: string;
  values: unknown[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `Invalid SQL identifier "${identifier}": must match ${IDENTIFIER_PATTERN}`,
    );
  }
  return `"${identifier}"`;
}

export interface SelectOptions {
  where?: Record<string, unknown>;
  orderBy?: string | { column: string; direction?: 'ASC' | 'DESC' };
  limit?: number;
}

export function buildSelect(table: string, options: SelectOptions = {}): BuiltQuery {
  const values: unknown[] = [];
  let text = `SELECT * FROM ${quoteIdentifier(table)}`;
  const where = options.where ?? {};
  const whereKeys = Object.keys(where);
  if (whereKeys.length > 0) {
    const clauses = whereKeys.map((key) => {
      values.push(where[key]);
      return `${quoteIdentifier(key)} = $${values.length}`;
    });
    text += ` WHERE ${clauses.join(' AND ')}`;
  }
  if (options.orderBy !== undefined) {
    if (typeof options.orderBy === 'string') {
      text += ` ORDER BY ${quoteIdentifier(options.orderBy)} ASC`;
    } else {
      const direction = options.orderBy.direction ?? 'ASC';
      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new Error(`Invalid sort direction "${String(direction)}"`);
      }
      text += ` ORDER BY ${quoteIdentifier(options.orderBy.column)} ${direction}`;
    }
  }
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 0) {
      throw new Error('limit must be a non-negative integer');
    }
    values.push(options.limit);
    text += ` LIMIT $${values.length}`;
  }
  return { text, values };
}

export function buildInsert(table: string, row: Record<string, unknown>): BuiltQuery {
  const keys = Object.keys(row);
  if (keys.length === 0) throw new Error('buildInsert requires a non-empty row');
  const columns = keys.map(quoteIdentifier).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  return {
    text: `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
    values: keys.map((k) => row[k]),
  };
}

export function buildUpdate(
  table: string,
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): BuiltQuery {
  const rowKeys = Object.keys(row);
  const whereKeys = Object.keys(where);
  if (rowKeys.length === 0) throw new Error('buildUpdate requires a non-empty row');
  if (whereKeys.length === 0) {
    throw new Error('buildUpdate requires a non-empty where (refusing unscoped update)');
  }
  const values: unknown[] = [];
  const sets = rowKeys.map((key) => {
    values.push(row[key]);
    return `${quoteIdentifier(key)} = $${values.length}`;
  });
  const clauses = whereKeys.map((key) => {
    values.push(where[key]);
    return `${quoteIdentifier(key)} = $${values.length}`;
  });
  return {
    text: `UPDATE ${quoteIdentifier(table)} SET ${sets.join(', ')} WHERE ${clauses.join(' AND ')} RETURNING *`,
    values,
  };
}

export class SqlStoreConnector {
  private readonly connectionString?: string;
  private readonly queryable?: Queryable;
  private pool: Pool | undefined;

  constructor(options: SqlStoreConnectorOptions) {
    if (!options.queryable && !options.connectionString) {
      throw new Error(
        'SqlStoreConnector requires either { connectionString } or { queryable }',
      );
    }
    this.connectionString = options.connectionString;
    this.queryable = options.queryable;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.connectionString });
    }
    return this.pool;
  }

  /** Pass-through query: `text` with `$n` placeholders + bound `values`. */
  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    if (this.queryable) {
      const result = await this.queryable.query(text, values);
      return {
        rows: result.rows,
        rowCount:
          typeof result.rowCount === 'number' ? result.rowCount : result.rows.length,
      };
    }
    const result = await this.getPool().query(text, values as never[]);
    return {
      rows: result.rows as unknown[],
      rowCount: result.rowCount ?? (result.rows as unknown[]).length,
    };
  }

  async select(
    table: string,
    options: SelectOptions = {},
  ): Promise<unknown[]> {
    const built = buildSelect(table, options);
    const { rows } = await this.query(built.text, built.values);
    return rows;
  }

  async insert(
    table: string,
    row: Record<string, unknown>,
  ): Promise<unknown[]> {
    const built = buildInsert(table, row);
    const { rows } = await this.query(built.text, built.values);
    return rows;
  }

  async update(
    table: string,
    row: Record<string, unknown>,
    where: Record<string, unknown>,
  ): Promise<unknown[]> {
    const built = buildUpdate(table, row, where);
    const { rows } = await this.query(built.text, built.values);
    return rows;
  }

  async end(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}
