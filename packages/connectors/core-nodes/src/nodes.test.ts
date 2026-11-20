import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NodeRegistry } from '@code-brothers/node-sdk';
import { nodes, registerCoreUtilityNodes } from './nodes.js';

describe('core utility registry', () => {
  it('a fresh NodeRegistry ends up with exactly the 4 utility types', () => {
    const registry = registerCoreUtilityNodes(new NodeRegistry());
    assert.equal(registry.size, 4);
    assert.deepEqual(registry.types().sort(), [
      'core.csvTransform',
      'core.emailSend',
      'core.googleSheetsAppend',
      'core.pdfGenerate',
    ]);
  });

  it('the exported nodes array matches the registered set', () => {
    assert.equal(nodes.length, 4);
    assert.deepEqual(
      nodes.map((n) => n.type).sort(),
      [
        'core.csvTransform',
        'core.emailSend',
        'core.googleSheetsAppend',
        'core.pdfGenerate',
      ],
    );
    for (const node of nodes) {
      assert.equal(typeof node.execute, 'function');
      assert.ok(node.displayName.length > 0);
    }
  });
});
