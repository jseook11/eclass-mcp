import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { downloadOne } from '../src/tools/download.js';
import type { DownloadDeps } from '../src/tools/download.js';
import type { DownloadRecord, ResolvedLocator } from '../src/file-cache.js';

function makeFileCache() {
  const records: DownloadRecord[] = [];
  const locators = new Map<string, ResolvedLocator>();
  return {
    records,
    locators,
    get: (id: string) => records.find((row) => row.file_id === id) ?? null,
    findByName: () => null,
    record: (entry: DownloadRecord) => { records.push(entry); },
    getResolvedLocator: (fileId: string) => locators.get(fileId),
    setResolvedLocator: (entry: ResolvedLocator) => { locators.set(entry.file_id, entry); },
  };
}

test('downloadOne launches ExternalTool wrapper URLs instead of fetching them as canvas files', async () => {
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-tool-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;

  const fetched: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetched.push(url);
    if (url === 'https://eclass3.cau.ac.kr/files/55/download') {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  let launches = 0;
  const session = {
    async resolveExternalToolLaunch() {
      launches += 1;
      return {
        kind: 'file' as const,
        url: 'https://eclass3.cau.ac.kr/files/55/download',
        type: 'pdf',
        filename: 'week1.pdf',
      };
    },
    async downloadCourseresourceFile() {
      throw new Error('courseresource path should not run for ExternalTool wrappers');
    },
  };
  const fileCache = makeFileCache();
  const deps = { session, fileCache, token: 'tok' } as unknown as DownloadDeps;

  try {
    const result = await downloadOne(deps, {
      file_id: '3707021',
      course_id: 147863,
      url: 'https://eclass3.cau.ac.kr/courses/147863/modules/items/3707021',
      display_name: 'week1',
      type: 'ExternalTool',
      source: 'external',
    });

    assert.equal(launches, 1);
    assert.equal(result.status, 'downloaded');
    assert.equal(result.strategy, 'external_tool_launch');
    assert.deepEqual(fetched, ['https://eclass3.cau.ac.kr/files/55/download']);
    assert.equal(fileCache.getResolvedLocator('3707021')?.resolved_url, 'https://eclass3.cau.ac.kr/files/55/download');
    assert.equal(fileCache.getResolvedLocator('3707021')?.resolved_type, 'pdf');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
    else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('downloadOne reuses a cached ExternalTool locator instead of launching again', async () => {
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-tool-cache-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://eclass3.cau.ac.kr/files/90/download') {
      return new Response(new Uint8Array([9, 9]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  let launches = 0;
  const session = {
    async resolveExternalToolLaunch() {
      launches += 1;
      throw new Error('launch should not run when a locator is cached');
    },
    async downloadCourseresourceFile() {
      throw new Error('courseresource path should not run');
    },
  };
  const fileCache = makeFileCache();
  fileCache.setResolvedLocator({
    file_id: '11',
    course_id: 1,
    resolved_url: 'https://eclass3.cau.ac.kr/files/90/download',
    resolved_type: 'pdf',
    display_name: 'iframe.pdf',
    resolved_at: '2026-09-01T00:00:00.000Z',
  });
  const deps = { session, fileCache, token: 'tok' } as unknown as DownloadDeps;

  try {
    const result = await downloadOne(deps, {
      file_id: '11',
      course_id: 1,
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      display_name: 'iframe.pdf',
      type: 'ExternalTool',
      is_playright_required: true,
    });

    assert.equal(launches, 0);
    assert.equal(result.status, 'downloaded');
    assert.equal(result.strategy, 'external_tool_launch');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
    else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('downloadOne hands a launched OCS viewer URL to the existing intercept path', async () => {
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-tool-ocs-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;

  const intercepted: Array<string | undefined> = [];
  const session = {
    async resolveExternalToolLaunch() {
      return { kind: 'ocs_viewer' as const, url: 'https://ocs.cau.ac.kr/em/slide-id', type: 'ocs' };
    },
    async downloadCourseresourceFile(
      courseId: number,
      _id: string,
      safeName: string,
      _dir: string,
      viewUrl?: string,
    ) {
      intercepted.push(viewUrl);
      const dir = path.join(tempDir, String(courseId));
      await fs.mkdir(dir, { recursive: true });
      const localPath = path.join(dir, safeName);
      await fs.writeFile(localPath, Buffer.from([7, 7, 7]));
      return localPath;
    },
  };
  const fileCache = makeFileCache();
  const deps = { session, fileCache, token: 'tok' } as unknown as DownloadDeps;

  try {
    const result = await downloadOne(deps, {
      file_id: '12',
      course_id: 88,
      url: 'https://eclass3.cau.ac.kr/courses/88/modules/items/12',
      display_name: 'slides.pptx',
      type: 'ExternalTool',
    });

    assert.deepEqual(intercepted, ['https://ocs.cau.ac.kr/em/slide-id']);
    assert.equal(result.status, 'downloaded');
    assert.equal(result.strategy, 'external_tool_launch');
    assert.equal(fileCache.getResolvedLocator('12')?.resolved_url, 'https://ocs.cau.ac.kr/em/slide-id');
  } finally {
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
    else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
