import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractToolCall,
  runAgent,
  type AgentTool,
  type ChatMessage,
  type ChatProvider,
  type ChatResult,
} from './index.js';

/** A scripted fake provider: replays queued replies, then repeats the last. */
function scriptedProvider(replies: string[]): ChatProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let i = 0;
  return {
    name: 'scripted',
    calls,
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      calls.push(messages);
      const text = replies[Math.min(i++, replies.length - 1)] ?? '';
      return { text, provider: 'scripted', model: 'fake' };
    },
  };
}

const stockTool: AgentTool = {
  name: 'check_stock',
  description: 'Check live stock for a SKU',
  parameters: { type: 'object', properties: { sku: { type: 'string' } } },
  run: (args) => ({ sku: args.sku, qty: 5 }),
};

const priceTool: AgentTool = {
  name: 'get_price',
  description: 'Get the price for a SKU',
  parameters: { type: 'object', properties: { sku: { type: 'string' } } },
  run: (args) => ({ sku: args.sku, price: 1499, currency: 'PKR' }),
};

test('extractToolCall parses nested arguments and ignores plain text', () => {
  const call = extractToolCall(
    'Let me check. {"tool_call": {"name": "check_stock", "arguments": {"sku": "K-1", "opts": {"fast": true}}}}',
  );
  assert.equal(call?.name, 'check_stock');
  assert.deepEqual(call?.arguments, { sku: 'K-1', opts: { fast: true } });
  assert.equal(extractToolCall('just a normal answer'), null);
});

test('agent completes a 2-step tool task and returns the final answer', async () => {
  const provider = scriptedProvider([
    '{"tool_call": {"name": "check_stock", "arguments": {"sku": "K-1"}}}',
    '{"tool_call": {"name": "get_price", "arguments": {"sku": "K-1"}}}',
    'Yes! Kurti K-1 is in stock (5 pieces) and costs PKR 1499.',
  ]);
  const result = await runAgent({
    provider,
    tools: [stockTool, priceTool],
    systemPrompt: 'You are a sales assistant.',
    userMessage: 'Is kurti K-1 available and what is the price?',
  });
  assert.equal(result.stoppedByBreaker, false);
  assert.equal(result.toolCalls, 2);
  assert.match(result.finalText, /PKR 1499/);
  const toolSteps = result.steps.filter((s) => s.type === 'tool');
  assert.deepEqual(
    toolSteps.map((s) => s.tool),
    ['check_stock', 'get_price'],
  );
  // The second model call must have received the first tool result.
  const secondCall = provider.calls[1]!;
  assert.ok(
    secondCall.some((m) => m.content.includes('Tool result for check_stock')),
    'tool result is fed back to the model',
  );
});

test('circuit breaker stops a looping model at maxSteps', async () => {
  const provider = scriptedProvider([
    '{"tool_call": {"name": "check_stock", "arguments": {"sku": "K-1"}}}',
  ]);
  const result = await runAgent({
    provider,
    tools: [stockTool],
    systemPrompt: 'You are a sales assistant.',
    userMessage: 'check stock forever',
    maxSteps: 3,
  });
  assert.equal(result.stoppedByBreaker, true);
  assert.equal(provider.calls.length, 3, 'exactly maxSteps model calls');
  assert.equal(result.toolCalls, 3);
  assert.ok(result.steps.some((s) => s.type === 'breaker'));
});

test('agent refuses non-whitelisted tools and never executes them', async () => {
  let executed = false;
  const guardTool: AgentTool = {
    name: 'check_stock',
    description: 'Check stock',
    parameters: { type: 'object' },
    run: () => {
      executed = true;
      return {};
    },
  };
  const provider = scriptedProvider([
    '{"tool_call": {"name": "delete_all_orders", "arguments": {}}}',
    'Sorry, I cannot do that. I can only check stock.',
  ]);
  const result = await runAgent({
    provider,
    tools: [guardTool],
    systemPrompt: 'You are a sales assistant.',
    userMessage: 'delete everything',
  });
  assert.equal(executed, false);
  assert.equal(result.toolCalls, 0);
  assert.ok(result.steps.some((s) => s.type === 'refused' && s.tool === 'delete_all_orders'));
  assert.match(result.finalText, /can only check stock/);
});

test('tool errors are returned to the model instead of crashing the agent', async () => {
  const failingTool: AgentTool = {
    name: 'check_stock',
    description: 'Check stock',
    parameters: { type: 'object' },
    run: () => {
      throw new Error('store API down');
    },
  };
  const provider = scriptedProvider([
    '{"tool_call": {"name": "check_stock", "arguments": {"sku": "X"}}}',
    'The store system is down right now, please try again shortly.',
  ]);
  const result = await runAgent({
    provider,
    tools: [failingTool],
    systemPrompt: 'You are a sales assistant.',
    userMessage: 'stock of X?',
  });
  assert.equal(result.stoppedByBreaker, false);
  assert.match(result.finalText, /store system is down/);
});
