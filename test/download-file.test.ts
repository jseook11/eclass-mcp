import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { downloadFile } from '../src/tools/download-file.js';

test('downloadFile follows announcement attachment redirects without leaking auth cross-origin', async () => {
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-file-test-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;

  const calls: Array<{ url: string; auth: string | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      auth: headers.get('Authorization'),
    });

    if (url === 'https://eclass3.cau.ac.kr/files/123/download') {
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://files.example.com/download/abc?signature=1',
        },
      });
    }

    if (url === 'https://files.example.com/download/abc?signature=1') {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
        },
      });
    }

    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const cache = {
      get: () => null,
      findByName: () => null,
      record: () => undefined,
    };

    const result = await downloadFile(
      '123',
      99,
      'https://eclass3.cau.ac.kr/files/123/download',
      'notice.pdf',
      'token-123',
      cache as never,
    );

    assert.equal(result.skipped, false);
    assert.equal(result.size_bytes, 4);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.auth, 'Bearer token-123');
    assert.equal(calls[1]?.auth, null);
    await assert.doesNotReject(() => fs.access(result.local_path));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) {
      delete process.env.ECLASS_DOWNLOAD_DIR;
    } else {
      process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
