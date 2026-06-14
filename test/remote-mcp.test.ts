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

test('buildToolList attaches an object outputSchema to every exposed tool', () => {
  const eclassNames = [
    'eclass_get_courses',
    'eclass_get_courses_cached',
    'eclass_doctor',
    'eclass_get_assignments',
    'eclass_get_assignment_detail',
    'eclass_get_grades',
    'eclass_sync_course_metadata',
    'eclass_sync_exam_schedules',
    'eclass_get_exam_schedule',
    'eclass_list_exam_sources',
    'eclass_search_syllabus',
    'eclass_get_syllabus',
    'eclass_submit_assignment',
    'eclass_search_downloads',
    'eclass_export_course_snapshot',
    'eclass_get_announcements',
    'eclass_get_materials',
    'eclass_download_file',
    'eclass_download_materials_batch',
    'eclass_download_video',
    'eclass_list_downloads',
    'eclass_get_download_status',
    'eclass_remove_download',
    'eclass_file_handoff',
  ];
  const tools = buildToolList(
    eclassNames.map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    })),
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of [...eclassNames, 'search', 'fetch']) {
    const schema = byName.get(name)?.outputSchema;
    assert.ok(schema, `${name} should have an outputSchema`);
    assert.equal(schema?.type, 'object', `${name} outputSchema must be an object`);
  }

  // 배열 반환 도구는 structuredContent.result 래퍼로 기술돼야 한다(normalizeToolResult와 일치).
  const arrayResultTools = [
    'eclass_get_courses',
    'eclass_get_courses_cached',
    'eclass_get_assignments',
    'eclass_get_announcements',
    'eclass_list_downloads',
  ];
  for (const name of arrayResultTools) {
    const props = byName.get(name)?.outputSchema?.properties as Record<string, { type?: string }> | undefined;
    assert.ok(props?.result, `${name} outputSchema should wrap an array in 'result'`);
    assert.equal(props?.result.type, 'array', `${name} 'result' should be an array`);
  }
});

test('explicit tool outputSchema is preserved over the registry default', () => {
  const custom = { type: 'object' as const, properties: { custom: { type: 'string' } } };
  const tools = buildToolList([
    {
      name: 'eclass_get_courses',
      description: 'courses',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: custom,
    },
  ]);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get('eclass_get_courses')?.outputSchema, custom);
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
