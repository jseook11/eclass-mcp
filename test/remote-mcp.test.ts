import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { startHttpServer } from '../src/http.js';
import { buildToolList, normalizeToolResult } from '../src/tools/registry.js';

function createEmptyServer(): Server {
  return new Server({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'remote-mcp-test', version: '0.0.0' },
    },
  });
}

test('buildToolList adds standard search/fetch tools and annotations', () => {
  const tools = buildToolList([
    {
      name: 'eclass_get_courses_cached',
      description: 'cached courses',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'eclass_submit_assignment',
      description: 'submit',
      inputSchema: { type: 'object', properties: {} },
    },
  ]);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('search')?.inputSchema.required?.[0], 'query');
  assert.equal(byName.get('fetch')?.inputSchema.required?.[0], 'id');
  assert.equal(byName.get('eclass_get_courses_cached')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('eclass_submit_assignment')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('eclass_submit_assignment')?.annotations?.destructiveHint, true);
});

test('normalizeToolResult preserves text JSON and adds structuredContent', () => {
  const result = normalizeToolResult({
    content: [{ type: 'text', text: JSON.stringify([{ id: 1, name: '운영체제' }]) }],
  });

  assert.deepEqual(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : 'null'), [
    { id: 1, name: '운영체제' },
  ]);
  assert.deepEqual(result.structuredContent, {
    result: [{ id: 1, name: '운영체제' }],
  });
});

test('HTTP /mcp enforces optional bearer auth', async () => {
  const httpServer = await startHttpServer({
    port: 0,
    authToken: 'test-token',
    createServer: createEmptyServer,
  });
  const address = httpServer.address();
  assert.equal(typeof address, 'object');
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initializeBody(),
    });
    assert.equal(authorized.status, 200);
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('HTTP /mcp accepts X-Eclass-Auth as an alternative to bearer', async () => {
  const httpServer = await startHttpServer({
    port: 0,
    authToken: 'test-token',
    createServer: createEmptyServer,
  });
  const address = httpServer.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const viaHeader = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'x-eclass-auth': 'test-token',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initializeBody(),
    });
    assert.equal(viaHeader.status, 200);

    const wrongHeader = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'x-eclass-auth': 'nope',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initializeBody(),
    });
    assert.equal(wrongHeader.status, 401);
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});

test('HTTP /mcp denies browser origins by default without breaking no-origin MCP clients', async () => {
  const httpServer = await startHttpServer({
    port: 0,
    createServer: createEmptyServer,
  });
  const address = httpServer.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const browserLike = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: initializeBody(),
    });
    assert.equal(browserLike.status, 403);

    const preflight = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 403);

    const noOrigin = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: initializeBody(),
    });
    assert.equal(noOrigin.status, 200);
  } finally {
    httpServer.close();
    await once(httpServer, 'close');
  }
});
