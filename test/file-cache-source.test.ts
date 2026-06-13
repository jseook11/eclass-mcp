import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { searchDownloads } from '../src/tools/search-downloads.js';
import type { DownloadRecord } from '../src/file-cache.js';

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-'));
  const dbPath = path.join(dir, 'files.db');
  const prev = process.env.ECLASS_DB_PATH;
  process.env.ECLASS_DB_PATH = dbPath;
  try {
    return fn(dbPath);
  } finally {
    if (prev === undefined) delete process.env.ECLASS_DB_PATH;
    else process.env.ECLASS_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('FileCache migrates an old downloaded_files table by adding source column', async () => {
  await withTempDb(async (dbPath) => {
    // Simulate a pre-migration DB without the `source` column
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE downloaded_files (
        file_id TEXT PRIMARY KEY, course_id INTEGER NOT NULL, display_name TEXT NOT NULL,
        local_path TEXT NOT NULL, downloaded_at TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE cached_courses (course_id INTEGER PRIMARY KEY, name TEXT NOT NULL, fetched_at TEXT NOT NULL);
    `);
    legacy.prepare('INSERT INTO downloaded_files VALUES (?,?,?,?,?,?)')
      .run('old1', 1, 'legacy.pdf', '/tmp/legacy.pdf', '2026-01-01T00:00:00.000Z', 10);
    legacy.close();

    // Importing FileCache fresh and constructing it should run the migration
    const { FileCache } = await import('../src/file-cache.js');
    const cache = new FileCache();

    const cols = (cache.getDb().prepare('PRAGMA table_info(downloaded_files)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('source'));

    // Old row survives with null source; new row can store a source
    const old = cache.get('old1');
    assert.equal(old?.source ?? null, null);

    cache.record({ file_id: 'new1', course_id: 1, display_name: 'new.pdf', local_path: '/tmp/new.pdf', downloaded_at: '2026-02-01T00:00:00.000Z', size_bytes: 20, source: 'files' });
    assert.equal(cache.get('new1')?.source, 'files');
  });
});

test('searchDownloads filters by source', () => {
  const records: DownloadRecord[] = [
    { file_id: 'a', course_id: 1, display_name: 'x.pdf', local_path: '/d/x.pdf', downloaded_at: '2026-01-01T00:00:00Z', size_bytes: 1, source: 'files' },
    { file_id: 'b', course_id: 1, display_name: 'y.pdf', local_path: '/d/y.pdf', downloaded_at: '2026-01-02T00:00:00Z', size_bytes: 1, source: 'courseresource' },
    { file_id: 'c', course_id: 1, display_name: 'z.pdf', local_path: '/d/z.pdf', downloaded_at: '2026-01-03T00:00:00Z', size_bytes: 1 },
  ];
  const result = searchDownloads(records, [], { source: 'courseresource' });
  assert.equal(result.total_matched, 1);
  assert.equal(result.matches[0].file_id, 'b');
});
