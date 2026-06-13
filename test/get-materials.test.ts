import test from 'node:test';
import assert from 'node:assert/strict';

import { getMaterials, isGetMaterialsToolError } from '../src/tools/get-materials.js';
import type { MaterialSource } from '../src/tools/get-materials.js';
import type { CanvasClient } from '../src/canvas-client.js';
import type { BrowserSession } from '../src/browser-session.js';
import type { FileCache } from '../src/file-cache.js';

function mockClient(
  fetchAll: (path: string, params?: Record<string, string>) => Promise<unknown[]>,
): CanvasClient {
  return { fetchAll } as CanvasClient;
}

function mockSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    interceptCourseresource: async () => [],
    interceptModulebuilder: async () => [],
    ...overrides,
  } as BrowserSession;
}

function mockCache(get: (fileId: string) => unknown): FileCache {
  return { get } as FileCache;
}

test('getMaterials returns materials and errors when one source fails', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) {
      return [
        {
          id: 1,
          name: 'Week 1',
          items: [{ id: 10, title: 'intro.pdf', type: 'File', html_url: '/courses/1/files/10' }],
        },
      ];
    }
    if (path.includes('/files')) {
      throw new Error('Canvas API error 500 https://eclass3.cau.ac.kr/api/v1/courses/1/files?access_token=secret');
    }
    return [];
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'files']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.equal(result.course_id, 1);
  assert.deepEqual(result.sources.requested, ['modules', 'files']);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, ['files']);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].title, 'intro.pdf');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'files');
  assert.equal(result.errors[0].retryable, true);
  assert.doesNotMatch(result.errors[0].reason, /access_token=secret/);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials returns ok false when all requested sources fail', async () => {
  const client = mockClient(async () => {
    throw new Error('Canvas API error 500');
  });
  const session = mockSession({
    interceptCourseresource: async () => {
      throw new Error('Playwright navigation timeout');
    },
  });

  const result = await getMaterials(client, session, 1, ['files', 'courseresource']);

  assert.equal(result.ok, false);
  assert.equal(isGetMaterialsToolError(result), true);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, []);
  assert.deepEqual(result.sources.failed, ['files', 'courseresource']);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((error) => error.source), ['files', 'courseresource']);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials returns ok true when all sources succeed with no materials', async () => {
  const client = mockClient(async () => []);

  const result = await getMaterials(client, mockSession(), 1, ['modules']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials reports files 401 and 403 as non-retryable errors', async () => {
  for (const status of [401, 403]) {
    const client = mockClient(async () => {
      throw new Error(`Canvas API error ${status}`);
    });

    const result = await getMaterials(client, mockSession(), 1, ['files']);

    assert.equal(result.ok, false);
    assert.equal(isGetMaterialsToolError(result), true);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].source, 'files');
    assert.equal(result.errors[0].retryable, false);
  }
});

test('getMaterials runs duplicate sources only once', async () => {
  let moduleFetchCount = 0;
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) {
      moduleFetchCount += 1;
    }
    return [];
  });

  const result = await getMaterials(
    client,
    mockSession(),
    1,
    ['modules', 'modules', 'modules'] as MaterialSource[],
  );

  assert.equal(moduleFetchCount, 1);
  assert.deepEqual(result.sources.requested, ['modules']);
});

test('getMaterials treats empty successful source plus failed source as partial success', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) return [];
    throw new Error('Canvas API error 500');
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'files']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, ['files']);
  assert.equal(result.errors.length, 1);
});

test('getMaterials reports cache failures as warnings without failing material lookup', async () => {
  const client = mockClient(async () => [
    {
      id: 1,
      name: 'Week 1',
      items: [
        { id: 10, title: 'intro.pdf', type: 'File', html_url: '/courses/1/files/10' },
        { id: 11, title: 'week2.pdf', type: 'File', html_url: '/courses/1/files/11' },
      ],
    },
  ]);
  const cache = mockCache(() => {
    throw new Error('SQLite busy');
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules'], cache);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.equal(result.materials.length, 2);
  assert.deepEqual(result.materials.map((material) => material.is_downloaded), [false, false]);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].source, 'cache');
});
