import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GeminiProvider,
  GroqProvider,
  OllamaProvider,
  ProviderError,
  type FetchLike,
} from './index.js';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchFn: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('OllamaProvider posts to /api/chat and parses the reply + usage', async () => {
  const { fetchFn, calls } = stubFetch(() =>
    jsonResponse({
      message: { role: 'assistant', content: 'Salaam! Stock available hai.' },
      prompt_eval_count: 12,
      eval_count: 7,
    }),
  );
  const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/', fetch: fetchFn });
  const res = await provider.chat([{ role: 'user', content: 'stock?' }]);
  assert.equal(res.text, 'Salaam! Stock available hai.');
  assert.equal(res.provider, 'ollama');
  assert.equal(res.usage?.totalTokens, 19);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'http://localhost:11434/api/chat');
  const body = JSON.parse(String(calls[0]!.init?.body)) as { stream: boolean; model: string };
  assert.equal(body.stream, false);
  assert.equal(body.model, 'qwen2.5:7b');
});

test('GroqProvider sends the current key as a Bearer token (OpenAI shape)', async () => {
  const { fetchFn, calls } = stubFetch(() =>
    jsonResponse({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
  );
  const provider = new GroqProvider({ apiKeys: ['key-one', 'key-two'], fetch: fetchFn });
  const res = await provider.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(res.text, 'ok');
  assert.equal(res.usage?.totalTokens, 4);
  const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer key-one');
  provider.rotateKey();
  await provider.chat([{ role: 'user', content: 'hi again' }]);
  const headers2 = (calls[1]!.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers2.authorization, 'Bearer key-two');
});

test('GeminiProvider uses the generateContent shape and joins parts', async () => {
  const { fetchFn, calls } = stubFetch(() =>
    jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }),
  );
  const provider = new GeminiProvider({ apiKeys: ['g-key'], fetch: fetchFn });
  const res = await provider.chat([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hi' },
  ]);
  assert.equal(res.text, 'Hello world');
  assert.equal(res.usage?.totalTokens, 7);
  assert.ok(calls[0]!.url.endsWith('/v1beta/models/gemini-2.0-flash:generateContent'));
  const body = JSON.parse(String(calls[0]!.init?.body)) as {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: Array<{ role: string }>;
  };
  assert.equal(body.systemInstruction?.parts[0]?.text, 'Be brief.');
  assert.equal(body.contents[0]?.role, 'user');
});

test('providers surface HTTP errors as retryable ProviderError', async () => {
  const { fetchFn } = stubFetch(() => new Response('slow down', { status: 429 }));
  const provider = new GroqProvider({ apiKeys: ['k'], fetch: fetchFn });
  await assert.rejects(provider.chat([{ role: 'user', content: 'x' }]), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 429);
    assert.equal(err.retryable, true);
    return true;
  });
});
