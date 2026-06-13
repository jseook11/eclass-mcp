import test from 'node:test';
import assert from 'node:assert/strict';

import { searchDownloads } from '../src/tools/search-downloads.js';
import type { DownloadRecord, CachedCourse } from '../src/file-cache.js';

const records: DownloadRecord[] = [
  { file_id: 'a', course_id: 1, display_name: '1주차 강의노트.pdf', local_path: '/d/1/note.pdf', downloaded_at: '2026-01-10T00:00:00.000Z', size_bytes: 100 },
  { file_id: 'b', course_id: 1, display_name: '실험보고서.docx', local_path: '/d/1/report.docx', downloaded_at: '2026-02-15T00:00:00.000Z', size_bytes: 200 },
  { file_id: 'c', course_id: 2, display_name: 'syllabus.pdf', local_path: '/d/2/syllabus.pdf', downloaded_at: '2026-03-01T00:00:00.000Z', size_bytes: 300 },
];

const courses: CachedCourse[] = [
  { course_id: 1, name: '일반물리실험', fetched_at: '2026-01-01T00:00:00.000Z' },
  { course_id: 2, name: '미적분학', fetched_at: '2026-01-01T00:00:00.000Z' },
];

test('searchDownloads filters by course_id', () => {
  const result = searchDownloads(records, courses, { course_id: 1 });
  assert.equal(result.total_matched, 2);
  assert.ok(result.matches.every((m) => m.course_id === 1));
});

test('searchDownloads matches query against filename and course name', () => {
  assert.equal(searchDownloads(records, courses, { query: '보고서' }).total_matched, 1);
  // course name match
  const byCourse = searchDownloads(records, courses, { query: '물리' });
  assert.equal(byCourse.total_matched, 2);
  assert.ok(byCourse.matches.every((m) => m.course_name === '일반물리실험'));
});

test('searchDownloads filters by extension with or without dot', () => {
  assert.equal(searchDownloads(records, courses, { extension: 'pdf' }).total_matched, 2);
  assert.equal(searchDownloads(records, courses, { extension: '.docx' }).total_matched, 1);
});

test('searchDownloads applies inclusive date range', () => {
  const result = searchDownloads(records, courses, {
    downloaded_after: '2026-02-01T00:00:00.000Z',
    downloaded_before: '2026-02-28T00:00:00.000Z',
  });
  assert.equal(result.total_matched, 1);
  assert.equal(result.matches[0].file_id, 'b');
});

test('searchDownloads enriches matches and sorts newest first', () => {
  const result = searchDownloads(records, courses, {});
  assert.equal(result.matches[0].file_id, 'c');
  assert.equal(result.matches[0].course_name, '미적분학');
  assert.equal(result.matches[0].extension, '.pdf');
});

test('searchDownloads respects limit but reports total', () => {
  const result = searchDownloads(records, courses, { limit: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.total_matched, 3);
  assert.equal(result.limit, 1);
});

test('searchDownloads ignores unparseable date bounds', () => {
  const result = searchDownloads(records, courses, { downloaded_after: 'not-a-date' });
  assert.equal(result.total_matched, 3);
});
