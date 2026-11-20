/** Minimal fetch stub that routes by "METHOD path" and records calls. */
export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

export function mockFetch(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const key = `${method} ${url}`;
    const route = routes[key];
    const payload = typeof route === 'function' ? (route as (b: unknown) => unknown)(body) : route;
    const status = method === 'POST' && url.includes('/api/workflows') && !url.includes('/run') ? 201 : 200;
    return new Response(JSON.stringify(payload ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

export const testUser = {
  id: 'user-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'owner',
  locale: 'en',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};
