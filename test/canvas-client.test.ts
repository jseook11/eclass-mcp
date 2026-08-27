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
  const rejectedTokens: string[] = [];
  const client = new CanvasClient('https://eclass3.cau.ac.kr', 'old-token', async (rejectedToken) => {
    refreshed += 1;
    rejectedTokens.push(rejectedToken);
    return 'new-token';
  });

  try {
    const result = await client.fetchOne<{ id: number }>('/api/v1/users/self');
    assert.equal(result.id, 1);
    assert.equal(refreshed, 1);
    assert.deepEqual(rejectedTokens, ['old-token']);
    assert.deepEqual(authHeaders, ['Bearer old-token', 'Bearer new-token']);
    assert.equal(client.getToken(), 'new-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent old-token 401s report their exact request token and converge', async () => {
  const originalFetch = globalThis.fetch;
  const oldResponses: Array<(response: Response) => void> = [];
  const authHeaders: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    authHeaders.push(authorization);
    if (authorization === 'Bearer old-token') {
      return new Promise<Response>((resolve) => oldResponses.push(resolve));
    }
    return new Response(JSON.stringify({ id: authorization }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const rejectedTokens: string[] = [];
  const client = new CanvasClient(
    'https://eclass3.cau.ac.kr',
    'old-token',
    async (rejectedToken) => {
      rejectedTokens.push(rejectedToken);
      return rejectedToken === 'old-token' ? 'new-token' : 'unexpected-rotation';
    },
  );

  try {
    const first = client.fetchOne<{ id: string }>('/api/v1/first');
    const second = client.fetchOne<{ id: string }>('/api/v1/second');
    while (oldResponses.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    oldResponses[0](new Response('{}', { status: 401 }));
    await first;
    assert.equal(client.getToken(), 'new-token');

    oldResponses[1](new Response('{}', { status: 401 }));
    await second;

    assert.deepEqual(rejectedTokens, ['old-token', 'old-token']);
    assert.deepEqual(authHeaders, [
      'Bearer old-token',
      'Bearer old-token',
      'Bearer new-token',
      'Bearer new-token',
    ]);
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

test('CanvasClient does not refresh on a course Files permission-denied 401', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      status: '권한이 없음',
      errors: [{ message: '사용자에게 이 동작을 수행할 권한이 없음' }],
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  let refreshed = 0;
  const client = new CanvasClient(
    'https://eclass3.cau.ac.kr',
    'token',
    async () => {
      refreshed += 1;
      return 'new-token';
    },
  );

  try {
    await assert.rejects(
      () => client.fetchAll('/api/v1/courses/139260/files'),
      /Canvas API error 401/,
    );
    assert.equal(calls, 1);
    assert.equal(refreshed, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
