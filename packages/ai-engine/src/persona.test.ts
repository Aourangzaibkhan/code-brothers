import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PERSONAS, defineAssistant } from './index.js';

test('defineAssistant validates and applies defaults', () => {
  const persona = defineAssistant({
    name: 'Test Bot',
    role: 'custom',
    systemPrompt: 'Be helpful.',
    toolWhitelist: ['check_stock'],
    providerPrefs: {},
  });
  assert.equal(persona.language, 'auto');
  assert.deepEqual(persona.toolWhitelist, ['check_stock']);
  assert.throws(
    () =>
      defineAssistant({ name: '', role: 'custom', systemPrompt: 'x', toolWhitelist: [], providerPrefs: {} }),
    /needs a name/,
  );
  assert.throws(
    () =>
      defineAssistant({ name: 'x', role: 'custom', systemPrompt: ' ', toolWhitelist: [], providerPrefs: {} }),
    /systemPrompt/,
  );
});

test('default personas match the spec roles with least-privilege tools', () => {
  assert.deepEqual(
    DEFAULT_PERSONAS.map((p) => p.role),
    ['sales', 'order-tracking', 'support', 'comment-moderator'],
  );
  for (const persona of DEFAULT_PERSONAS) {
    assert.ok(persona.systemPrompt.length > 20);
    assert.ok(persona.toolWhitelist.length > 0);
    assert.ok((persona.providerPrefs.preferred?.length ?? 0) > 0);
  }
  // The support persona must never hold a refund-issuing tool (human approval only).
  const support = DEFAULT_PERSONAS.find((p) => p.role === 'support')!;
  assert.ok(!support.toolWhitelist.some((t) => t.includes('refund')));
});
