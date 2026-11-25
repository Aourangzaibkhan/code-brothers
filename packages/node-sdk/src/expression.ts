import vm from 'node:vm';

/**
 * Sandboxed `{{ ... }}` expression engine.
 *
 * Security model (defence in depth — node:vm alone is not a boundary):
 *  1. The expression source is scanned for forbidden identifiers
 *     (process, require, globalThis, constructor, __proto__, eval, Function,
 *     import, Buffer, module, exports, global) and rejected up front with a
 *     clear ExpressionError.
 *  2. Run data is handed to the sandbox as a JSON string and parsed *inside*
 *     the context, so every object the expression can touch belongs to the
 *     sandbox realm — host-realm prototype chains are never reachable.
 *  3. The vm context is created with codeGeneration.strings = false, so
 *     eval / the Function constructor throw inside the sandbox.
 *  4. Execution is capped by the vm timeout (default 2s, per spec).
 */

export class ExpressionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExpressionError';
  }
}

export interface ExpressionData {
  /** JSON of the item currently being processed. */
  $json?: Record<string, unknown>;
  /** All items on the current node's input. */
  $items?: unknown[];
  /** Upstream node results by node name: `$node["Fetch"].json`. */
  $node?: Record<string, { json: Record<string, unknown> }>;
  /** Workflow variables. */
  $vars?: Record<string, unknown>;
  $workflow?: { id: string; name?: string };
  $execution?: { id: string };
}

export interface ExpressionOptions {
  /** Sandbox CPU timeout in ms. Default 2000 (spec: 2s). */
  timeoutMs?: number;
}

const FORBIDDEN_IDENTIFIERS = [
  'process',
  'require',
  'globalThis',
  'global',
  'constructor',
  '__proto__',
  'prototype',
  'eval',
  'Function',
  'import',
  'module',
  'exports',
  'Buffer',
  'Reflect',
  'Proxy',
  'WeakRef',
];

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(${FORBIDDEN_IDENTIFIERS.join('|')})\\b`,
);

function assertSourceAllowed(source: string): void {
  const match = FORBIDDEN_PATTERN.exec(source);
  if (match) {
    throw new ExpressionError(
      `Expression uses forbidden identifier "${match[1]}": expressions may only read workflow data ($json, $node, $vars, $items)`,
    );
  }
}

const BOOTSTRAP = `
  const __data = JSON.parse(globalThis.__cb_payload);
  delete globalThis.__cb_payload;
  globalThis.$json = __data.$json ?? {};
  globalThis.$items = __data.$items ?? [];
  globalThis.$node = __data.$node ?? {};
  globalThis.$vars = __data.$vars ?? {};
  globalThis.$workflow = __data.$workflow ?? {};
  globalThis.$execution = __data.$execution ?? {};
`;

/**
 * Evaluate a single expression (the inside of `{{ ... }}`, without braces)
 * against run data. Returns the typed value.
 */
export function evaluateExpression(
  source: string,
  data: ExpressionData = {},
  options: ExpressionOptions = {},
): unknown {
  const trimmed = source.trim();
  if (!trimmed) throw new ExpressionError('Empty expression');
  assertSourceAllowed(trimmed);

  const timeoutMs = options.timeoutMs ?? 2000;
  const sandbox: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  let payload: string;
  try {
    payload = JSON.stringify(data) ?? '{}';
  } catch {
    throw new ExpressionError('Expression data is not JSON-serializable');
  }
  sandbox.__cb_payload = payload;

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    new vm.Script(BOOTSTRAP).runInContext(context, { timeout: timeoutMs });
    const script = new vm.Script(`(${trimmed})`);
    const result: unknown = script.runInContext(context, {
      timeout: timeoutMs,
    });
    // Objects created inside the sandbox belong to the sandbox realm (their
    // prototypes differ from the host's, which breaks deep-equality and
    // structured handling downstream). Re-materialize plain data results in
    // the host realm via a JSON round-trip.
    if (result !== null && typeof result === 'object') {
      return JSON.parse(JSON.stringify(result)) as unknown;
    }
    return result;
  } catch (err) {
    if (err instanceof ExpressionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) {
      throw new ExpressionError(
        `Expression exceeded the ${timeoutMs}ms sandbox timeout`,
        { cause: err },
      );
    }
    throw new ExpressionError(`Expression failed: ${message}`, { cause: err });
  }
}

const TEMPLATE_PATTERN = /\{\{([\s\S]*?)\}\}/g;

/**
 * Render a template value against run data.
 * - A string that is exactly one `{{ expr }}` returns the typed value.
 * - A string with embedded `{{ expr }}` parts is string-interpolated
 *   (null/undefined render as empty text).
 * - Non-string values pass through unchanged.
 */
export function renderTemplate(
  template: unknown,
  data: ExpressionData = {},
  options: ExpressionOptions = {},
): unknown {
  if (typeof template !== 'string') return template;
  if (!template.includes('{{')) return template;

  const matches = [...template.matchAll(TEMPLATE_PATTERN)];
  if (matches.length === 0) return template;

  const first = matches[0];
  if (
    matches.length === 1 &&
    first &&
    template.trim() === first[0]
  ) {
    return evaluateExpression(first[1] ?? '', data, options);
  }

  return template.replace(TEMPLATE_PATTERN, (_whole, expr: string) => {
    const value = evaluateExpression(expr, data, options);
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Deep-render every string inside a plain object/array template. */
export function renderDeep(
  value: unknown,
  data: ExpressionData = {},
  options: ExpressionOptions = {},
): unknown {
  if (typeof value === 'string') return renderTemplate(value, data, options);
  if (Array.isArray(value)) {
    return value.map((entry) => renderDeep(entry, data, options));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = renderDeep(entry, data, options);
    }
    return out;
  }
  return value;
}
