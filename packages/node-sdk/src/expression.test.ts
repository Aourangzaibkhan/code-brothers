import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ExpressionError,
  evaluateExpression,
  renderTemplate,
} from './expression.js';

const data = {
  $json: { name: 'Ada', price: 21, tags: ['a', 'b'], nested: { id: 42 } },
  $node: { Fetch: { json: { id: 7, title: 'Hello' } } },
  $vars: { region: 'pk' },
};

describe('evaluateExpression', () => {
  it('reads $json fields', () => {
    assert.equal(evaluateExpression('$json.name', data), 'Ada');
    assert.equal(evaluateExpression('$json.nested.id', data), 42);
  });

  it('reads $node output by name with bracket access', () => {
    assert.equal(evaluateExpression('$node["Fetch"].json.id', data), 7);
    assert.equal(evaluateExpression('$node.Fetch.json.title', data), 'Hello');
  });

  it('supports arithmetic, methods and $vars', () => {
    assert.equal(evaluateExpression('$json.price * 2', data), 42);
    assert.equal(evaluateExpression('$json.tags.length', data), 2);
    assert.equal(evaluateExpression('$json.name.toUpperCase()', data), 'ADA');
    assert.equal(evaluateExpression('$vars.region', data), 'pk');
  });

  it('throws ExpressionError for unknown data', () => {
    assert.throws(
      () => evaluateExpression('$missing.value', data),
      ExpressionError,
    );
  });

  it('throws ExpressionError on an empty expression', () => {
    assert.throws(() => evaluateExpression('   ', data), ExpressionError);
  });
});

describe('sandbox escapes are blocked', () => {
  const attempts: Array<[string, string]> = [
    ['process.env', 'process.env'],
    ['process exit', 'process.exit(1)'],
    ['require', 'require("node:fs")'],
    ['globalThis', 'globalThis.process'],
    ['Function constructor', 'Function("return process")()'],
    ['constructor escape via $json', '$json.name.constructor.constructor("return process")()'],
    ['__proto__ access', '$json["__proto__"]'],
    ['eval', 'eval("1+1")'],
    ['dynamic import', 'import("node:fs")'],
  ];
  for (const [label, source] of attempts) {
    it(`blocks: ${label}`, () => {
      assert.throws(() => evaluateExpression(source, data), ExpressionError);
    });
  }

  it('enforces the sandbox timeout on runaway expressions', () => {
    assert.throws(
      () =>
        evaluateExpression('(() => { for (;;) {} })()', data, {
          timeoutMs: 100,
        }),
      (err: unknown) =>
        err instanceof ExpressionError && /timeout/i.test(err.message),
    );
  });

  it('host objects are not reachable: data is sandbox-realm JSON', () => {
    // Even a benign-looking chain cannot climb to a host constructor because
    // `constructor` is forbidden and data is re-parsed inside the sandbox.
    assert.throws(
      () => evaluateExpression('({}).toString.constructor', data),
      ExpressionError,
    );
  });
});

describe('renderTemplate', () => {
  it('returns the typed value for a whole-string expression', () => {
    assert.equal(renderTemplate('{{ $json.price * 2 }}', data), 42);
    assert.deepEqual(renderTemplate('{{ $json.nested }}', data), { id: 42 });
  });

  it('interpolates embedded expressions as text', () => {
    assert.equal(
      renderTemplate('Hello {{ $json.name }}, region {{ $vars.region }}', data),
      'Hello Ada, region pk',
    );
  });

  it('renders missing values as empty text when embedded', () => {
    assert.equal(renderTemplate('[{{ $json.nope }}]', data), '[]');
  });

  it('passes non-strings and plain strings through unchanged', () => {
    assert.equal(renderTemplate(42, data), 42);
    assert.equal(renderTemplate('no expressions here', data), 'no expressions here');
    assert.deepEqual(renderTemplate({ a: 1 }, data), { a: 1 });
  });
});
