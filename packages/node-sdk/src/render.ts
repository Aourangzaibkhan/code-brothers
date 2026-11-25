import type { NodeContext } from './types.js';

/**
 * Per-item parameter rendering for connector nodes.
 *
 * Node parameters are templates: a workflow author writes
 * `"to": "{{ $json.customerPhone }}"` and expects the value for the item
 * currently being processed. Core nodes render their own parameters, but
 * connector nodes used to read `ctx.parameters` raw — so a `{{ ... }}`
 * string was sent to the provider literally. Every connector node renders
 * its parameters through these helpers before calling its provider.
 *
 * A template that is exactly one `{{ expression }}` keeps its evaluated
 * type (number stays a number); anything else is string-interpolated —
 * the same rule `renderTemplate` applies everywhere.
 */

/** Deep-render a parameter value against one item's JSON. */
export function renderValue(
  ctx: NodeContext,
  value: unknown,
  itemJson: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') return ctx.renderTemplate(value, itemJson);
  if (Array.isArray(value)) {
    return value.map((entry) => renderValue(ctx, entry, itemJson));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = renderValue(ctx, entry, itemJson);
    }
    return out;
  }
  return value;
}

/** Render one named node parameter against one item's JSON. */
export function renderParam(
  ctx: NodeContext,
  name: string,
  itemJson: Record<string, unknown>,
): unknown {
  return renderValue(ctx, ctx.parameters[name], itemJson);
}

/** Render a named parameter as a string ('' when missing). */
export function renderStringParam(
  ctx: NodeContext,
  name: string,
  itemJson: Record<string, unknown>,
): string {
  const value = renderParam(ctx, name, itemJson);
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Render the whole parameters object against one item's JSON. Use for
 * nodes that make a single provider call from static-ish parameters
 * (list/get nodes) — rendered against the first input item so `$vars.*`
 * and `$json.*` from the trigger still resolve.
 */
export function renderParams(
  ctx: NodeContext,
  itemJson: Record<string, unknown>,
): Record<string, unknown> {
  const rendered = renderValue(ctx, ctx.parameters, itemJson);
  return (rendered ?? {}) as Record<string, unknown>;
}
