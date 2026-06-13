import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CanvasClient } from '../canvas-client.js';
import { BrowserSession } from '../browser-session.js';
import { FileCache } from '../file-cache.js';
import { expandTilde } from '../utils.js';
import { getAssignments } from './get-assignments.js';
import { getAnnouncements } from './get-announcements.js';
import { getMaterials } from './get-materials.js';
import { getGrades } from './get-grades.js';
import type { Material } from './get-materials.js';
import type { CourseGrade } from './get-grades.js';
import type { Assignment, Announcement } from '../types.js';
import { sanitizeDebug } from '../errors.js';

export type SnapshotFormat = 'json' | 'markdown';

export interface SnapshotPartialFailure {
  section: string;
  reason: string;
}

export interface CourseSnapshot {
  course_id: number;
  course_name: string | null;
  generated_at: string;
  assignments: Assignment[];
  announcements: Announcement[];
  materials: Material[];
  download_status: {
    file_count: number;
    total_size_bytes: number;
    files: Array<{ display_name: string; local_path: string; size_bytes: number; downloaded_at: string }>;
  };
  grades: CourseGrade | null;     // only when include_grades
  partial_failures: SnapshotPartialFailure[];
}

export interface ExportSnapshotResult {
  ok: boolean;
  course_id: number;
  format: SnapshotFormat;
  local_path?: string;
  snapshot?: CourseSnapshot;
  content?: string;               // markdown when not written to a file
  partial_failures: SnapshotPartialFailure[];
  error_code?: string;
  message?: string;
  next_action?: string;
}

export interface ExportSnapshotDeps {
  client: CanvasClient;
  session: BrowserSession;
  fileCache: FileCache;
}

export interface ExportSnapshotInput {
  course_id: number;
  format: SnapshotFormat;
  include_grades?: boolean;
  output_path?: string;
  overwrite?: boolean;
}

function reasonOf(err: unknown): string {
  return sanitizeDebug(err instanceof Error ? err.message : String(err)) || 'Unknown error';
}

export function renderMarkdown(snapshot: CourseSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${snapshot.course_name ?? `Course ${snapshot.course_id}`}`);
  lines.push('');
  lines.push(`- course_id: ${snapshot.course_id}`);
  lines.push(`- generated_at: ${snapshot.generated_at}`);
  if (snapshot.partial_failures.length > 0) {
    lines.push(`- ⚠️ 일부 섹션 수집 실패: ${snapshot.partial_failures.map((f) => f.section).join(', ')}`);
  }
  lines.push('');

  lines.push(`## 과제 (${snapshot.assignments.length})`);
  for (const a of snapshot.assignments) {
    const status = a.is_submitted ? '제출' : a.is_missing ? '미제출(지남)' : '미제출';
    lines.push(`- ${a.title} — 마감 ${a.due_at ?? '없음'} — ${status}`);
  }
  lines.push('');

  lines.push(`## 공지 (${snapshot.announcements.length})`);
  for (const n of snapshot.announcements) {
    lines.push(`- ${n.title} — ${n.author} — ${n.posted_at ?? ''}`);
  }
  lines.push('');

  lines.push(`## 자료 (${snapshot.materials.length})`);
  for (const m of snapshot.materials) {
    const dl = m.is_downloaded ? '✓ 다운로드됨' : '';
    lines.push(`- [${m.source}] ${m.title} ${dl}`.trimEnd());
  }
  lines.push('');

  lines.push(`## 다운로드 현황`);
  lines.push(`- 파일 ${snapshot.download_status.file_count}개, ${snapshot.download_status.total_size_bytes} bytes`);
  lines.push('');

  if (snapshot.grades) {
    lines.push(`## 성적`);
    lines.push(`- 현재 점수: ${snapshot.grades.current_score ?? '-'} (${snapshot.grades.current_grade ?? '-'})`);
    lines.push(`- 최종 점수: ${snapshot.grades.final_score ?? '-'} (${snapshot.grades.final_grade ?? '-'})`);
    for (const a of snapshot.grades.assignments ?? []) {
      lines.push(`  - ${a.name}: ${a.score ?? '-'}/${a.points_possible ?? '-'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function exportCourseSnapshot(
  deps: ExportSnapshotDeps,
  input: ExportSnapshotInput,
  generatedAt: string = new Date().toISOString(),
): Promise<ExportSnapshotResult> {
  const { client, session, fileCache } = deps;
  const { course_id, format } = input;
  const includeGrades = input.include_grades ?? false;
  const partial: SnapshotPartialFailure[] = [];

  // output_path는 LLM이 지정하는 임의 경로 — 기존 파일을 확인 없이 덮어쓰지 않는다.
  if (input.output_path) {
    const resolved = path.resolve(expandTilde(input.output_path));
    const exists = await fs.stat(resolved).then(() => true).catch(() => false);
    if (exists && !input.overwrite) {
      return {
        ok: false,
        course_id,
        format,
        partial_failures: [],
        error_code: 'SNAPSHOT_OUTPUT_EXISTS',
        message: `출력 경로에 이미 파일이 존재합니다: ${resolved}`,
        next_action: '덮어쓰려면 overwrite=true를 지정하거나 다른 output_path를 사용하세요.',
      };
    }
  }

  const cachedCourse = fileCache.getCachedCourse(course_id);

  const [assignments, announcements, materialsResult] = await Promise.all([
    getAssignments(client, course_id).catch((err) => {
      partial.push({ section: 'assignments', reason: reasonOf(err) });
      return [] as Assignment[];
    }),
    getAnnouncements(client, course_id).catch((err) => {
      partial.push({ section: 'announcements', reason: reasonOf(err) });
      return [] as Announcement[];
    }),
    getMaterials(client, session, course_id, undefined, fileCache).catch((err) => {
      partial.push({ section: 'materials', reason: reasonOf(err) });
      return null;
    }),
  ]);

  if (materialsResult) {
    for (const e of materialsResult.errors) {
      partial.push({ section: `materials:${e.source}`, reason: e.reason });
    }
  }

  let grades: CourseGrade | null = null;
  if (includeGrades) {
    try {
      const result = await getGrades(client, course_id, true);
      grades = result.courses.find((c) => c.course_id === course_id) ?? null;
      for (const e of result.errors) partial.push({ section: `grades:${e.scope}`, reason: e.reason });
    } catch (err) {
      partial.push({ section: 'grades', reason: reasonOf(err) });
    }
  }

  const records = fileCache.list(course_id);

  const snapshot: CourseSnapshot = {
    course_id,
    course_name: cachedCourse?.name ?? null,
    generated_at: generatedAt,
    assignments,
    announcements,
    materials: materialsResult?.materials ?? [],
    download_status: {
      file_count: records.length,
      total_size_bytes: records.reduce((sum, r) => sum + r.size_bytes, 0),
      files: records.map((r) => ({
        display_name: r.display_name,
        local_path: r.local_path,
        size_bytes: r.size_bytes,
        downloaded_at: r.downloaded_at,
      })),
    },
    grades,
    partial_failures: partial,
  };

  const result: ExportSnapshotResult = {
    ok: true,
    course_id,
    format,
    partial_failures: partial,
  };

  if (input.output_path) {
    const resolved = path.resolve(expandTilde(input.output_path));
    const content = format === 'markdown' ? renderMarkdown(snapshot) : JSON.stringify(snapshot, null, 2);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    result.local_path = resolved;
  } else if (format === 'markdown') {
    result.content = renderMarkdown(snapshot);
  } else {
    result.snapshot = snapshot;
  }

  return result;
}
