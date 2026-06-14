import { statSync } from 'node:fs';
import type { BrowserSession } from '../browser-session.js';
import { registerHandoff } from '../file-handoff-registry.js';
import { inferMimeType } from './file-handoff.js';
import type { CanvasClient } from '../canvas-client.js';
import type { FileCache } from '../file-cache.js';
import type { ExamCache } from '../exam-cache.js';
import type { Course } from '../types.js';
import { getCourses } from './get-courses.js';
import { getAssignments } from './get-assignments.js';
import { getAnnouncements } from './get-announcements.js';
import { getMaterials } from './get-materials.js';
import type { MaterialSource } from './get-materials.js';
import { searchDownloads } from './search-downloads.js';
import { searchSyllabusList, getSyllabus } from '../mportal-client.js';
import { getAssignmentDetail } from './get-assignment-detail.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';
const MAX_RESULTS = 20;
const MAX_COURSES_TO_SCAN = 3;
const SEARCH_TIMEOUT_MS = 15_000;

export type SearchResult = {
  id: string;
  title: string;
  url: string;
};

export type SearchResponse = {
  results: SearchResult[];
};

export type FetchResponse = {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata?: Record<string, string>;
};

export type StandardToolContext = {
  session: BrowserSession;
  fileCache: FileCache;
  examCache: ExamCache;
  // When set (HTTP transport), fetch on a download id returns a clickable
  // download URL so ChatGPT can hand the file to the user without trying to
  // read it as an MCP resource (which this server does not expose).
  handoffBaseUrl?: string;
};

function includes(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle);
}

function addUnique(results: SearchResult[], item: SearchResult): void {
  if (results.length >= MAX_RESULTS) return;
  if (results.some((existing) => existing.id === item.id)) return;
  results.push(item);
}

async function bestEffort<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return fallback;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadCourses(client: CanvasClient, fileCache: FileCache): Promise<Course[]> {
  const live = await bestEffort(async () => {
    const courses = await getCourses(client);
    fileCache.upsertCourses(courses);
    return courses;
  }, []);
  if (live.length > 0) return live;
  return fileCache.listCachedCourses().map((course) => ({
    id: course.course_id,
    name: course.name,
  }));
}

function encodePart(value: string | number): string {
  return encodeURIComponent(String(value));
}

function courseTitle(course: Course): string {
  return `[강의] ${course.name}`;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function statSizeOrZero(localPath: string): number {
  try {
    return statSync(localPath).size;
  } catch {
    return 0;
  }
}

function parseEclassId(id: string): { kind: string; parts: string[]; params: URLSearchParams } {
  const parsed = new URL(id);
  if (parsed.protocol !== 'eclass:') throw new Error('Unsupported fetch id protocol');
  return {
    kind: parsed.hostname,
    parts: parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent),
    params: parsed.searchParams,
  };
}

export async function searchEclassDocuments(
  context: StandardToolContext,
  query: string,
): Promise<SearchResponse> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const remaining = () => deadline - Date.now();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return { results: [] };

  const client = await context.session.getClient();
  const courses = await withTimeout(
    loadCourses(client, context.fileCache),
    remaining(),
    context.fileCache.listCachedCourses().map((course) => ({
      id: course.course_id,
      name: course.name,
    })),
  );
  const results: SearchResult[] = [];

  for (const course of courses) {
    if (includes(course.name, normalizedQuery)) {
      addUnique(results, {
        id: `eclass://course/${course.id}`,
        title: courseTitle(course),
        url: `${BASE_URL}/courses/${course.id}`,
      });
    }
  }

  const assignmentGroups = await withTimeout(
    Promise.all(courses.map(async (course) => ({
      course,
      assignments: await bestEffort(() => getAssignments(client, course.id, 365, true), []),
    }))),
    remaining(),
    [],
  );
  for (const { course, assignments } of assignmentGroups) {
    if (results.length >= MAX_RESULTS) break;
    for (const assignment of assignments) {
      if (!includes(`${course.name} ${assignment.title}`, normalizedQuery)) continue;
      if (!assignment.assignment_id) continue;
      const idPart = `eclass://assignment/${course.id}/${assignment.assignment_id}`;
      addUnique(results, {
        id: idPart,
        title: `[과제] ${course.name} - ${assignment.title}`,
        url: assignment.url ?? idPart,
      });
    }
  }

  const downloadMatches = searchDownloads(
    context.fileCache.list(),
    context.fileCache.listCachedCourses(),
    { query, limit: 10 },
  ).matches;
  for (const record of downloadMatches) {
    addUnique(results, {
      id: `eclass://download/${encodePart(record.file_id)}`,
      title: `[다운로드] ${record.course_name ? `${record.course_name} - ` : ''}${record.display_name}`,
      url: `eclass://download/${encodePart(record.file_id)}`,
    });
  }

  const scannedCourses = courses
    .filter((course) => includes(course.name, normalizedQuery))
    .slice(0, MAX_COURSES_TO_SCAN);

  for (const course of scannedCourses) {
    if (remaining() <= 0) break;
    const announcements = await withTimeout(
      bestEffort(() => getAnnouncements(client, course.id, 10), []),
      remaining(),
      [],
    );
    for (const announcement of announcements) {
      if (!includes(`${announcement.title} ${announcement.message}`, normalizedQuery)) continue;
      addUnique(results, {
        id: `eclass://announcement/${course.id}/${announcement.id}`,
        title: `[공지] ${course.name} - ${announcement.title}`,
        url: `eclass://announcement/${course.id}/${announcement.id}`,
      });
    }

    const materials = await withTimeout(
      bestEffort(
        () => getMaterials(
          client,
          context.session,
          course.id,
          ['modules', 'files', 'courseresource', 'announcements'] as MaterialSource[],
          context.fileCache,
        ),
        null,
      ),
      remaining(),
      null,
    );
    if (materials?.materials) {
      for (const material of materials.materials) {
        if (!includes(`${material.title} ${material.type}`, normalizedQuery)) continue;
        addUnique(results, {
          id: `eclass://material/${course.id}/${encodePart(material.id)}`,
          title: `[자료] ${course.name} - ${material.title}`,
          url: material.url ?? `eclass://material/${course.id}/${encodePart(material.id)}`,
        });
      }
    }
  }

  const syllabus = await withTimeout(
    bestEffort(
      () => searchSyllabusList(context.session, { query, by: 'subject' }),
      { ok: false as const, error_code: 'SYLLABUS_SEARCH_FAILED', message: 'best-effort search failed' },
    ),
    remaining(),
    { ok: false as const, error_code: 'SYLLABUS_SEARCH_FAILED', message: 'best-effort search failed' },
  );
  if (syllabus.ok) {
    for (const item of syllabus.items.slice(0, 5)) {
      const id = `eclass://syllabus/${encodePart(item.year)}/${encodePart(item.term)}/${encodePart(item.course_code)}/${encodePart(item.section)}?campcd=${encodePart(item.campus_code ?? '')}&sust=${encodePart(item.sust_code ?? '')}`;
      addUnique(results, {
        id,
        title: `[강의계획서] ${item.course_name} (${item.professor ?? '교수 미상'})`,
        url: id,
      });
    }
  }

  return { results };
}

export async function fetchEclassDocument(
  context: StandardToolContext,
  id: string,
): Promise<FetchResponse> {
  const parsed = parseEclassId(id);
  const client = await context.session.getClient();

  if (parsed.kind === 'course') {
    const courseId = Number(parsed.parts[0]);
    const courses = await loadCourses(client, context.fileCache);
    const course = courses.find((item) => item.id === courseId);
    if (!course) throw new Error(`Course not found: ${courseId}`);
    return {
      id,
      title: courseTitle(course),
      text: jsonText(course),
      url: `${BASE_URL}/courses/${course.id}`,
      metadata: { type: 'course', course_id: String(course.id) },
    };
  }

  if (parsed.kind === 'assignment' && parsed.parts.length >= 2) {
    const [rawCourseId, rawAssignmentId] = parsed.parts;
    if (rawCourseId === 'unknown') {
      // Legacy guard for planner-derived IDs emitted before search returned exact course IDs.
      throw new Error('Assignment id does not include course_id; call eclass_get_courses/eclass_get_assignments with course_id for exact fetch.');
    }
    const courseId = Number(rawCourseId);
    const assignmentId = Number(rawAssignmentId);
    const result = await getAssignmentDetail(client, courseId, assignmentId);
    return {
      id,
      title: result.ok ? `[과제] ${result.assignment.name}` : '[과제] 조회 실패',
      text: jsonText(result),
      url: result.ok ? (result.assignment.html_url ?? id) : id,
      metadata: { type: 'assignment', course_id: String(courseId), assignment_id: String(assignmentId) },
    };
  }

  if (parsed.kind === 'announcement' && parsed.parts.length >= 2) {
    const [rawCourseId, rawAnnouncementId] = parsed.parts;
    const courseId = Number(rawCourseId);
    const announcementId = Number(rawAnnouncementId);
    const announcements = await getAnnouncements(client, courseId, 100);
    const announcement = announcements.find((item) => item.id === announcementId);
    if (!announcement) throw new Error(`Announcement not found: ${announcementId}`);
    return {
      id,
      title: `[공지] ${announcement.title}`,
      text: jsonText(announcement),
      url: id,
      metadata: { type: 'announcement', course_id: String(courseId), announcement_id: String(announcementId) },
    };
  }

  if (parsed.kind === 'material' && parsed.parts.length >= 2) {
    const [rawCourseId, rawMaterialId] = parsed.parts;
    const courseId = Number(rawCourseId);
    const materials = await getMaterials(client, context.session, courseId, undefined, context.fileCache);
    const material = materials.materials.find((item) => item.id === rawMaterialId);
    if (!material) throw new Error(`Material not found: ${rawMaterialId}`);
    return {
      id,
      title: `[자료] ${material.title}`,
      text: jsonText(material),
      url: material.url ?? id,
      metadata: { type: 'material', course_id: String(courseId), material_id: rawMaterialId },
    };
  }

  if (parsed.kind === 'download' && parsed.parts.length >= 1) {
    const fileId = parsed.parts[0];
    const record = context.fileCache.list().find((item) => item.file_id === fileId);
    if (!record) throw new Error(`Download record not found: ${fileId}`);
    const sizeBytes = record.size_bytes > 0 ? record.size_bytes : statSizeOrZero(record.local_path);
    let downloadUrl: string | undefined;
    if (context.handoffBaseUrl) {
      const token = registerHandoff({
        localPath: record.local_path,
        displayName: record.display_name,
        mimeType: inferMimeType(record.display_name),
        sizeBytes,
      });
      downloadUrl = `${context.handoffBaseUrl.replace(/\/$/, '')}/files/${token}`;
    }
    return {
      id,
      title: `[다운로드] ${record.display_name}`,
      text: downloadUrl
        ? `${record.display_name} (${sizeBytes} bytes)\n\n다운로드 링크: ${downloadUrl}\n브라우저에서 이 URL을 열면 파일이 저장됩니다. 링크는 일정 시간 후 만료됩니다.`
        : jsonText({
            file_id: record.file_id,
            display_name: record.display_name,
            local_path: record.local_path,
            size_bytes: record.size_bytes,
            downloaded_at: record.downloaded_at,
            source: record.source,
          }),
      url: downloadUrl ?? id,
      metadata: {
        type: 'download',
        file_id: fileId,
        ...(downloadUrl ? { download_url: downloadUrl } : {}),
      },
    };
  }

  if (parsed.kind === 'syllabus' && parsed.parts.length >= 4) {
    const [year, term, sbjtno1, clssno1] = parsed.parts;
    const result = await getSyllabus(context.session, {
      year,
      term,
      sbjtno1,
      clssno1,
      campcd: parsed.params.get('campcd') ?? undefined,
      sust: parsed.params.get('sust') ?? undefined,
    });
    return {
      id,
      title: result.ok ? `[강의계획서] ${result.document.basic.title_ko ?? sbjtno1}` : '[강의계획서] 조회 실패',
      text: jsonText(result),
      url: id,
      metadata: { type: 'syllabus', year, term, course_code: sbjtno1, section: clssno1 },
    };
  }

  throw new Error(`Unsupported fetch id: ${id}`);
}
