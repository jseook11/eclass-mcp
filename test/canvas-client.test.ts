import test from 'node:test';
import assert from 'node:assert/strict';

import { CanvasClient } from '../src/canvas-client.js';

test('CanvasClient retries once with a fresh token on 401', async () => {
  const originalFetch = globalThis.fetch;
  const authHeaders: Array<string | null> = [];
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    authHeaders.push(new Headers(init?.headers).get('Authorization'));
    if (calls === 1) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  let refreshed = 0;
  const client = new CanvasClient('https://eclass3.cau.ac.kr', 'old-token', async () => {
    refreshed += 1;
    return 'new-token';
  });

  try {
    const result = await client.fetchOne<{ id: number }>('/api/v1/users/self');
    assert.equal(result.id, 1);
    assert.equal(refreshed, 1);
    assert.deepEqual(authHeaders, ['Bearer old-token', 'Bearer new-token']);
    assert.equal(client.getToken(), 'new-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CanvasClient without onAuthError surfaces 401 directly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;

  const client = new CanvasClient('https://eclass3.cau.ac.kr', 'token');
  try {
    await assert.rejects(() => client.fetchOne('/api/v1/users/self'), /Canvas API error 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CanvasClient does not retry twice when refreshed token is also rejected', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 401 });
  }) as typeof fetch;

  const client = new CanvasClient('https://eclass3.cau.ac.kr', 'old', async () => 'new');
  try {
    await assert.rejects(() => client.fetchOne('/api/v1/users/self'), /Canvas API error 401/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
