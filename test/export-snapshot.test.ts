import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { renderMarkdown, exportCourseSnapshot } from '../src/tools/export-snapshot.js';
import type { CourseSnapshot } from '../src/tools/export-snapshot.js';

const sampleSnapshot: CourseSnapshot = {
  course_id: 1,
  course_name: '일반물리실험',
  generated_at: '2026-06-12T00:00:00.000Z',
  assignments: [
    { title: '보고서1', course_name: '일반물리실험', due_at: '2026-06-20T23:59:00.000+09:00', is_submitted: false, is_missing: false, url: null },
  ],
  announcements: [
    { id: 1, title: '휴강 안내', author: '교수', posted_at: '2026-06-01T10:00:00.000+09:00', message: '휴강', has_attachment: false },
  ],
  materials: [
    { id: 'm1', title: '1주차.pdf', type: 'application/pdf', url: 'https://x/f', source: 'files', is_downloaded: true },
  ],
  download_status: { file_count: 1, total_size_bytes: 1234, files: [] },
  grades: null,
  partial_failures: [],
};

test('renderMarkdown includes all sections', () => {
  const md = renderMarkdown(sampleSnapshot);
  assert.match(md, /# 일반물리실험/);
  assert.match(md, /## 과제 \(1\)/);
  assert.match(md, /보고서1/);
  assert.match(md, /## 공지 \(1\)/);
  assert.match(md, /## 자료 \(1\)/);
  assert.match(md, /✓ 다운로드됨/);
  assert.ok(!md.includes('## 성적'));
});

test('renderMarkdown shows grades section when present', () => {
  const md = renderMarkdown({ ...sampleSnapshot, grades: { course_id: 1, course_name: '물리', current_score: 90, current_grade: 'A', final_score: 85, final_grade: 'B+', assignments: [] } });
  assert.match(md, /## 성적/);
  assert.match(md, /현재 점수: 90/);
});

// Stubs for the orchestrator. Canvas calls return empty; Playwright-backed
// material sources throw → captured as partial failures (not a hard error).
function makeClient(): any {
  return {
    getToken: () => 'tok',
    async fetchAll(): Promise<never[]> { return []; },
    async fetchOne(): Promise<unknown> { return {}; },
  };
}

function makeSession(): any {
  return {
    async interceptCourseresource(): Promise<never> { throw new Error('playwright down'); },
    async interceptModulebuilder(): Promise<never> { throw new Error('playwright down'); },
  };
}

function makeFileCache(): any {
  return {
    getCachedCourse: () => ({ course_id: 1, name: '일반물리실험', fetched_at: '2026-01-01T00:00:00.000Z' }),
    list: () => [],
    listCachedCourses: () => [],
  };
}

test('exportCourseSnapshot returns json snapshot with partial failures', async () => {
  const result = await exportCourseSnapshot(
    { client: makeClient(), session: makeSession(), fileCache: makeFileCache() },
    { course_id: 1, format: 'json' },
    '2026-06-12T00:00:00.000Z',
  );

  assert.equal(result.ok, true);
  assert.equal(result.format, 'json');
  assert.ok(result.snapshot);
  assert.equal(result.snapshot?.course_name, '일반물리실험');
  // courseresource + modulebuilder failed
  const sections = result.partial_failures.map((f) => f.section);
  assert.ok(sections.includes('materials:courseresource'));
  assert.ok(sections.includes('materials:modulebuilder'));
});

test('exportCourseSnapshot writes file when output_path is given', async () => {
  const outPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'snap-')), 'course.md');
  const result = await exportCourseSnapshot(
    { client: makeClient(), session: makeSession(), fileCache: makeFileCache() },
    { course_id: 1, format: 'markdown', output_path: outPath },
    '2026-06-12T00:00:00.000Z',
  );

  assert.equal(result.local_path, path.resolve(outPath));
  assert.equal(result.snapshot, undefined);
  const written = await fs.readFile(outPath, 'utf8');
  assert.match(written, /# 일반물리실험/);
  await fs.rm(path.dirname(outPath), { recursive: true, force: true });
});
