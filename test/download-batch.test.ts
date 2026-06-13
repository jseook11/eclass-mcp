import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { downloadMaterialsBatch } from '../src/tools/download-batch.js';
import type { DownloadDeps } from '../src/tools/download.js';
import type { DownloadRecord } from '../src/file-cache.js';

function makeFileCache() {
  const records: DownloadRecord[] = [];
  return {
    records,
    get: (_id: string) => null,
    findByName: (_c: number, _n: string) => null,
    record: (entry: DownloadRecord) => { records.push(entry); },
    list: () => records,
  } as any;
}

test('downloadMaterialsBatch handles mixed strategies with partial success', async () => {
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://eclass3.cau.ac.kr/files/1/download') {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;

  const fileCache = makeFileCache();

  // Fake session: write a real file so fs.stat succeeds on the playwright path.
  const session = {
    async downloadCourseresourceFile(courseId: number, _id: string, safeName: string): Promise<string> {
      const dir = path.join(tempDir, String(courseId));
      await fs.mkdir(dir, { recursive: true });
      const p = path.join(dir, safeName);
      await fs.writeFile(p, Buffer.from([9, 9]));
      return p;
    },
  };

  const deps = { session, fileCache, token: 'tok' } as unknown as DownloadDeps;

  try {
    const result = await downloadMaterialsBatch(deps, 88, [
      { file_id: 'f1', course_id: 88, url: 'https://eclass3.cau.ac.kr/files/1/download', display_name: 'a.pdf', source: 'files' },
      { file_id: 'f2', course_id: 88, url: 'https://ocs.cau.ac.kr/em/abc123', display_name: 'b.pdf', source: 'courseresource' },
      { file_id: 'f3', course_id: 88, url: null, display_name: 'movie.mp4', type: 'mp4', source: 'modulebuilder' },
    ]);

    assert.equal(result.ok, false);             // one failure (streaming)
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.downloaded, 2);
    assert.equal(result.summary.failed, 1);

    const byId = Object.fromEntries(result.results.map((r) => [r.file_id, r]));
    assert.equal(byId['f1'].strategy, 'canvas_file');
    assert.equal(byId['f1'].status, 'downloaded');
    assert.equal(byId['f2'].strategy, 'ocs_intercept');
    assert.equal(byId['f2'].status, 'downloaded');
    assert.equal(byId['f3'].strategy, 'unsupported_streaming_media');
    assert.equal(byId['f3'].status, 'failed');
    assert.equal(byId['f3'].error_code, 'DOWNLOAD_UNSUPPORTED_MEDIA');
    assert.equal(byId['f3'].retryable, false);

    // source threaded into cache records
    const sources = fileCache.records.map((r: DownloadRecord) => r.source).sort();
    assert.deepEqual(sources, ['courseresource', 'files']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
    else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('downloadMaterialsBatch stops at first failure when continue_on_error is false', async () => {
  const fileCache = makeFileCache();
  const session = { async downloadCourseresourceFile(): Promise<string> { throw new Error('should not reach'); } };
  const deps = { session, fileCache, token: 'tok' } as unknown as DownloadDeps;

  const result = await downloadMaterialsBatch(deps, 88, [
    { file_id: 'f1', course_id: 88, url: null, display_name: 'a.mp4', type: 'video' },
    { file_id: 'f2', course_id: 88, url: 'https://eclass3.cau.ac.kr/files/2/download', display_name: 'b.pdf' },
  ], false);

  assert.equal(result.summary.total, 1);        // stopped after first failure
  assert.equal(result.results[0].status, 'failed');
});
