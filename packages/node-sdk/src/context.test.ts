import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestNodeContext } from './context.js';
import { createRedactingLogger, MemoryNodeLogger } from './logger.js';

describe('createTestNodeContext', () => {
  it('serves configured credentials and undefined for unknown slots', async () => {
    const { ctx } = createTestNodeContext({
      credentials: { shopifyApi: { apiKey: 'k', shop: 'demo.myshopify.com' } },
    });
    assert.deepEqual(await ctx.getCredentials('shopifyApi'), {
      apiKey: 'k',
      shop: 'demo.myshopify.com',
    });
    assert.equal(await ctx.getCredentials('missing'), undefined);
  });

  it('exposes parameters and variables', () => {
    const { ctx } = createTestNodeContext({
      parameters: { url: 'https://example.com' },
      variables: { region: 'pk' },
    });
    assert.equal(ctx.parameters.url, 'https://example.com');
    assert.equal(ctx.variables.region, 'pk');
  });

  it('records sleeps instead of really waiting', async () => {
    const { ctx, sleeps } = createTestNodeContext();
    await ctx.sleep(25);
    await ctx.sleep(50);
    assert.deepEqual(sleeps, [25, 50]);
  });

  it('expression methods render for real by default (same engine as the runtime)', () => {
    const { ctx } = createTestNodeContext({
      variables: { shop: 'acme' },
    });
    assert.equal(ctx.evaluateExpression('$json.x + 1', { x: 41 }), 42);
    assert.equal(
      ctx.renderTemplate('Hello {{ $json.name }} from {{ $vars.shop }}', {
        name: 'Ada',
      }),
      'Hello Ada from acme',
    );
  });

  it('injected expression methods still override the default', () => {
    const { ctx } = createTestNodeContext({
      renderTemplate: () => 'injected',
    });
    assert.equal(ctx.renderTemplate('{{ $json.x }}'), 'injected');
  });

  it('logger records entries in memory', () => {
    const { ctx, logger } = createTestNodeContext();
    ctx.logger.info('hello', { a: 1 });
    assert.equal(logger.entries.length, 1);
    assert.equal(logger.entries[0]?.message, 'hello');
    assert.equal(logger.entries[0]?.level, 'info');
  });
});

describe('createRedactingLogger', () => {
  it('passes meta through the redactor before logging', () => {
    const base = new MemoryNodeLogger();
    const logger = createRedactingLogger(base, (value) => {
      const clone = JSON.parse(JSON.stringify(value)) as Record<
        string,
        unknown
      >;
      if ('apiKey' in clone) clone.apiKey = '[REDACTED]';
      return clone;
    });
    logger.info('call', { apiKey: 'secret', url: 'https://example.com' });
    assert.equal(base.entries.length, 1);
    assert.equal(base.entries[0]?.meta?.apiKey, '[REDACTED]');
    assert.equal(base.entries[0]?.meta?.url, 'https://example.com');
  });
});
