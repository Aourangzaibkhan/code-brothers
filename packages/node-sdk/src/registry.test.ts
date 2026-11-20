import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineNode } from './define-node.js';
import {
  DuplicateNodeTypeError,
  NodeRegistry,
  UnknownNodeTypeError,
} from './registry.js';
import type { NodeDefinition } from './types.js';

function sampleNode(type: string): NodeDefinition {
  return defineNode({
    type,
    displayName: 'Sample',
    description: 'A sample node',
    version: 1,
    category: 'Test',
    inputs: { type: 'array' },
    outputs: { type: 'array' },
    async execute(_ctx, input) {
      return [input];
    },
  });
}

describe('NodeRegistry', () => {
  it('registers, gets and lists nodes', () => {
    const registry = new NodeRegistry();
    const a = sampleNode('test.a');
    const b = sampleNode('test.b');
    registry.register(a);
    registry.registerAll([b]);

    assert.equal(registry.size, 2);
    assert.equal(registry.get('test.a'), a);
    assert.equal(registry.getOrThrow('test.b'), b);
    assert.ok(registry.has('test.a'));
    assert.deepEqual(registry.types().sort(), ['test.a', 'test.b']);
    assert.equal(registry.list().length, 2);
  });

  it('rejects duplicate type ids', () => {
    const registry = new NodeRegistry();
    registry.register(sampleNode('test.dup'));
    assert.throws(
      () => registry.register(sampleNode('test.dup')),
      DuplicateNodeTypeError,
    );
  });

  it('getOrThrow throws for unknown types, get returns undefined', () => {
    const registry = new NodeRegistry();
    assert.equal(registry.get('nope'), undefined);
    assert.throws(() => registry.getOrThrow('nope'), UnknownNodeTypeError);
  });

  it('unregister and clear work', () => {
    const registry = new NodeRegistry();
    registry.register(sampleNode('test.x'));
    assert.equal(registry.unregister('test.x'), true);
    assert.equal(registry.has('test.x'), false);
    registry.register(sampleNode('test.y'));
    registry.clear();
    assert.equal(registry.size, 0);
  });
});

describe('defineNode', () => {
  it('returns a valid definition unchanged', () => {
    const def = sampleNode('test.ok');
    assert.equal(def.type, 'test.ok');
  });

  it('throws on an empty type id', () => {
    assert.throws(
      () =>
        defineNode({
          type: '  ',
          displayName: 'X',
          description: 'X',
          version: 1,
          category: 'Test',
          inputs: {},
          outputs: {},
          async execute(_ctx, input) {
            return [input];
          },
        }),
      TypeError,
    );
  });

  it('throws when execute is missing', () => {
    assert.throws(
      () =>
        defineNode({
          type: 'test.noexec',
          displayName: 'X',
          description: 'X',
          version: 1,
          category: 'Test',
          inputs: {},
          outputs: {},
          // @ts-expect-error deliberately malformed definition
          execute: undefined,
        }),
      TypeError,
    );
  });
});
