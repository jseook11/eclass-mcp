import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function withTempDb<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-'));
  const dbPath = path.join(dir, 'files.db');
  const prev = process.env.ECLASS_DB_PATH;
  process.env.ECLASS_DB_PATH = dbPath;
  try {
    return await fn(dbPath);
  } finally {
    if (prev === undefined) delete process.env.ECLASS_DB_PATH;
    else process.env.ECLASS_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('FileCache stores and reuses a resolved ExternalTool locator', async () => {
  await withTempDb(async () => {
    const { FileCache } = await import('../src/file-cache.js');
    const cache = new FileCache();

    assert.equal(cache.getResolvedLocator('3707021'), undefined);

    cache.setResolvedLocator({
      file_id: '3707021',
      course_id: 147863,
      resolved_url: 'https://eclass3.cau.ac.kr/files/55/download',
      resolved_type: 'pdf',
      display_name: 'week1.pdf',
      resolved_at: '2026-09-01T00:00:00.000Z',
    });

    assert.deepEqual(cache.getResolvedLocator('3707021'), {
      file_id: '3707021',
      course_id: 147863,
      resolved_url: 'https://eclass3.cau.ac.kr/files/55/download',
      resolved_type: 'pdf',
      display_name: 'week1.pdf',
      resolved_at: '2026-09-01T00:00:00.000Z',
    });
  });
});

test('FileCache.remove clears the matching resolved locator', async () => {
  await withTempDb(async () => {
    const { FileCache } = await import('../src/file-cache.js');
    const cache = new FileCache();
    cache.setResolvedLocator({
      file_id: '3707021',
      course_id: 147863,
      resolved_url: 'https://eclass3.cau.ac.kr/files/55/download',
      resolved_at: '2026-09-01T00:00:00.000Z',
    });

    assert.equal(cache.remove('3707021'), false);
    assert.equal(cache.getResolvedLocator('3707021'), undefined);
  });
});

test('FileCache.removeCourse clears all resolved locators for the course', async () => {
  await withTempDb(async () => {
    const { FileCache } = await import('../src/file-cache.js');
    const cache = new FileCache();
    cache.setResolvedLocator({
      file_id: '3707021',
      course_id: 147863,
      resolved_url: 'https://eclass3.cau.ac.kr/files/55/download',
      resolved_at: '2026-09-01T00:00:00.000Z',
    });
    cache.setResolvedLocator({
      file_id: 'other-course',
      course_id: 1,
      resolved_url: 'https://eclass3.cau.ac.kr/files/99/download',
      resolved_at: '2026-09-01T00:00:00.000Z',
    });

    assert.equal(cache.removeCourse(147863), 0);
    assert.equal(cache.getResolvedLocator('3707021'), undefined);
    assert.notEqual(cache.getResolvedLocator('other-course'), undefined);
  });
});
