import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildOcsMp4Url,
  downloadVideo,
  extractOcsContentId,
  parseMainMediaFromXml,
} from '../src/tools/download-video.js';
import type { DownloadRecord } from '../src/file-cache.js';

function makeFileCache(existing?: DownloadRecord) {
  const records: DownloadRecord[] = [];
  return {
    records,
    get: (id: string) => existing && existing.file_id === id ? existing : null,
    findByName: () => null,
    record: (entry: DownloadRecord) => { records.push(entry); },
  } as any;
}

test('OCS video helpers parse supported UniPlayer MP4 metadata', () => {
  assert.equal(extractOcsContentId('https://ocs.cau.ac.kr/em/6a11c78f348bf'), '6a11c78f348bf');
  assert.equal(parseMainMediaFromXml('<root><main_media><![CDATA[screen.mp4]]></main_media></root>'), 'screen.mp4');
  assert.equal(
    buildOcsMp4Url('abc123', 'screen.mp4'),
    'https://cau-cms-object.cdn.gov-ntruss.com/contents_new/cau1000001/abc123/contents/media_files/screen.mp4',
  );
  assert.throws(() => parseMainMediaFromXml('<main_media>playlist.m3u8</main_media>'), /Only OCS UniPlayer MP4/);
});

test('downloadVideo verifies and downloads OCS MP4 without sending credentials to CDN', async () => {
  const originalFetch = globalThis.fetch;
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-download-'));
  process.env.ECLASS_DOWNLOAD_DIR = tempDir;
  const calls: Array<{ url: string; auth: string | null; range: string | null }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('Authorization'), range: headers.get('Range') });

    if (url === 'https://ocs.cau.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=abc123') {
      return new Response('<root><main_media>screen.mp4</main_media></root>', { status: 200, headers: { 'content-type': 'text/xml' } });
    }
    if (url === 'https://cau-cms-object.cdn.gov-ntruss.com/contents_new/cau1000001/abc123/contents/media_files/screen.mp4' && headers.get('Range') === 'bytes=0-15') {
      return new Response(new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), {
        status: 206,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    if (url === 'https://cau-cms-object.cdn.gov-ntruss.com/contents_new/cau1000001/abc123/contents/media_files/screen.mp4') {
      return new Response(new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const cache = makeFileCache();
  try {
    const result = await downloadVideo({
      video_id: 'v1',
      course_id: 88,
      url: 'https://ocs.cau.ac.kr/em/abc123',
      display_name: 'lecture',
      type: 'mp4',
      source: 'courseresource',
    }, cache);

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.equal(result.strategy, 'ocs_uniplayer_mp4');
    assert.equal(result.skipped, false);
    assert.equal(result.size_bytes, 11);
    assert.ok(result.local_path.endsWith(path.join('88', 'lecture.mp4')));
    assert.equal(cache.records.length, 1);
    assert.equal(cache.records[0].source, 'courseresource');
    assert.ok(calls.every((call) => call.auth === null));
    assert.ok(calls.some((call) => call.range === 'bytes=0-15'));
    await assert.doesNotReject(() => fs.access(result.local_path));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
    else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('downloadVideo returns cache hit without network', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-cache-'));
  const localPath = path.join(tempDir, 'cached.mp4');
  await fs.writeFile(localPath, Buffer.from([1, 2, 3]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network should not be called');
  }) as typeof fetch;

  try {
    const result = await downloadVideo({
      video_id: 'cached',
      course_id: 1,
      url: 'https://ocs.cau.ac.kr/em/abc123',
      display_name: 'cached.mp4',
    }, makeFileCache({
      file_id: 'video:cached',
      course_id: 1,
      display_name: 'cached.mp4',
      local_path: localPath,
      downloaded_at: '2026-06-12T00:00:00.000Z',
      size_bytes: 3,
    }));

    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('expected success');
    assert.equal(result.skipped, true);
    assert.equal(result.local_path, localPath);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('downloadVideo rejects responses without an MP4 signature', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('content.php')) {
      return new Response('<root><main_media>screen.mp4</main_media></root>', { status: 200 });
    }
    // content-type은 video/mp4지만 ftyp 시그니처가 아닌 바이트
    return new Response(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), {
      status: 206,
      headers: { 'content-type': 'video/mp4' },
    });
  }) as typeof fetch;

  try {
    const result = await downloadVideo({
      video_id: 'sig',
      course_id: 1,
      url: 'https://ocs.cau.ac.kr/em/abc123',
      display_name: 'fake',
    }, makeFileCache());

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    assert.equal(result.error_code, 'VIDEO_DOWNLOAD_UNSUPPORTED');
    assert.equal(result.retryable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadVideo reports transient CDN failures as retryable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('content.php')) {
      return new Response('<root><main_media>screen.mp4</main_media></root>', { status: 200 });
    }
    return new Response('server error', { status: 503 });
  }) as typeof fetch;

  try {
    const result = await downloadVideo({
      video_id: 'flaky',
      course_id: 1,
      url: 'https://ocs.cau.ac.kr/em/abc123',
      display_name: 'flaky',
    }, makeFileCache());

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    assert.equal(result.error_code, 'VIDEO_DOWNLOAD_FAILED');
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('downloadVideo rejects unsupported HLS metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response('<root><main_media>playlist.m3u8</main_media></root>', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await downloadVideo({
      video_id: 'hls',
      course_id: 1,
      url: 'https://ocs.cau.ac.kr/em/hls123',
      display_name: 'hls',
    }, makeFileCache());

    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    assert.equal(result.error_code, 'VIDEO_DOWNLOAD_UNSUPPORTED');
    assert.match(result.next_action ?? '', /HLS\/m3u8\/DRM/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
