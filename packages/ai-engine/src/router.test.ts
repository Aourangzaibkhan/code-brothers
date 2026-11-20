import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AllProvidersFailedError,
  GroqProvider,
  HybridRouter,
  OllamaProvider,
  type FetchLike,
} from './index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('router falls back to the next provider on HTTP 500', async () => {
  const failingFetch: FetchLike = async () => new Response('boom', { status: 500 });
  const okFetch: FetchLike = async () =>
    jsonResponse({ message: { content: 'from ollama' }, prompt_eval_count: 1, eval_count: 1 });
  const router = new HybridRouter([
    new GroqProvider({ apiKeys: ['only-key'], fetch: failingFetch }),
    new OllamaProvider({ fetch: okFetch }),
  ]);
  const outcome = await router.route([{ role: 'user', content: 'hi' }]);
  assert.equal(outcome.provider, 'ollama');
  assert.equal(outcome.result.text, 'from ollama');
  assert.equal(outcome.attempts[0]?.provider, 'groq');
  assert.equal(outcome.attempts[0]?.ok, false);
  assert.equal(outcome.attempts[0]?.status, 500);
});

test('router rotates API keys on 429 and the same provider answers', async () => {
  const seenAuth: string[] = [];
  const rotatingFetch: FetchLike = async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuth.push(headers.authorization ?? '');
    if (headers.authorization === 'Bearer key-1') {
      return new Response('rate limited', { status: 429 });
    }
    return jsonResponse({
      choices: [{ message: { content: 'answered with key 2' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  const router = new HybridRouter([
    new GroqProvider({ apiKeys: ['key-1', 'key-2'], fetch: rotatingFetch }),
  ]);
  const outcome = await router.route([{ role: 'user', content: 'hi' }]);
  assert.equal(outcome.provider, 'groq');
  assert.equal(outcome.result.text, 'answered with key 2');
  assert.deepEqual(seenAuth, ['Bearer key-1', 'Bearer key-2']);
});

test('router falls back on network error', async () => {
  const deadFetch: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };
  const okFetch: FetchLike = async () =>
    jsonResponse({ message: { content: 'local answer' } });
  const router = new HybridRouter([
    new GroqProvider({ apiKeys: ['k'], fetch: deadFetch }),
    new OllamaProvider({ fetch: okFetch }),
  ]);
  const outcome = await router.route([{ role: 'user', content: 'hi' }]);
  assert.equal(outcome.provider, 'ollama');
  assert.equal(outcome.result.text, 'local answer');
});

test('a failed provider enters cooldown and is skipped on the next route', async () => {
  let groqCalls = 0;
  const failingFetch: FetchLike = async () => {
    groqCalls++;
    return new Response('down', { status: 503 });
  };
  const okFetch: FetchLike = async () => jsonResponse({ message: { content: 'ok' } });
  let now = 1_000_000;
  const router = new HybridRouter(
    [
      new GroqProvider({ apiKeys: ['k'], fetch: failingFetch }),
      new OllamaProvider({ fetch: okFetch }),
    ],
    { cooldownMs: 60_000, now: () => now },
  );
  await router.route([{ role: 'user', content: 'one' }]);
  assert.equal(groqCalls, 1);
  assert.deepEqual(router.coolingDown(), ['groq']);
  await router.route([{ role: 'user', content: 'two' }]);
  assert.equal(groqCalls, 1, 'cooled-down provider must not be called again');
  now += 61_000; // cooldown (60s x 1 failure) expires
  await router.route([{ role: 'user', content: 'three' }]);
  assert.equal(groqCalls, 2, 'provider is retried after cooldown');
});

test('router throws AllProvidersFailedError when every provider fails', async () => {
  const failingFetch: FetchLike = async () => new Response('nope', { status: 500 });
  const router = new HybridRouter([new GroqProvider({ apiKeys: ['k'], fetch: failingFetch })]);
  await assert.rejects(router.route([{ role: 'user', content: 'hi' }]), (err: unknown) => {
    assert.ok(err instanceof AllProvidersFailedError);
    assert.equal(err.attempts.length, 1);
    return true;
  });
});
