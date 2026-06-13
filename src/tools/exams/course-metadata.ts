import type { CanvasClient } from '../../canvas-client.js';
import type { ExamCache, CourseMetadataRecord } from '../../exam-cache.js';
import { fetchSisCourseInfo, type SisCourseInfoResult } from '../../learningx-client.js';

interface RawCanvasCourse {
  id: number | string;
  name?: string | null;
  course_code?: string | null;
  sis_course_id?: string | null;
  term?: { name?: string | null } | null;
  teachers?: Array<{ display_name?: string | null }> | null;
  account?: { name?: string | null } | null;
}

// 일반 파싱 규칙으로는 단과대가 안 잡히지만 개설 조직이 확정된 account 이름의 매핑.
// "대학(전체)"는 교양/공통 교과의 개설 조직으로, 교양대학(ge_notice) 공지가 시험 일정을
// 담당한다 → 전체 소스 fallback 대신 교양대학으로 정확히 라우팅한다.
const KNOWN_ACCOUNT_COLLEGE: Record<string, { college: string; department: string | null }> = {
  '대학(전체)': { college: '교양대학', department: null },
};

/**
 * Canvas account(개설 조직) 이름에서 단과대/학부를 파싱한다.
 * live 검증된 형태(docs/DISCOVERY.md): "{단과대} {학부} [{전공}]"
 * 예: "소프트웨어대학 소프트웨어학부", "경영경제대학 경영학부(서울) 경영학".
 * 첫 토큰이 "…대학"으로 끝나는 2토큰 이상이면 확정 파싱하고,
 * KNOWN_ACCOUNT_COLLEGE에 등록된 이름은 그 매핑을 쓰며,
 * 그 외("중앙대학교" 등)는 null로 두고 원문만 보존한다.
 */
export function parseCanvasAccountName(
  name: string | null | undefined,
): { college: string | null; department: string | null } {
  const trimmed = name?.trim();
  if (!trimmed) return { college: null, department: null };
  const known = KNOWN_ACCOUNT_COLLEGE[trimmed];
  if (known) return known;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2 || !tokens[0].endsWith('대학')) return { college: null, department: null };
  return { college: tokens[0], department: tokens[1] };
}

export type SisFetcher = (client: CanvasClient, courseId: number) => Promise<SisCourseInfoResult>;

export interface SyncCourseMetadataResult {
  ok: boolean;
  synced: CourseMetadataRecord[];
  errors: Array<{ course_id?: number; reason: string; retryable: boolean }>;
}

function asCourseId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

async function toMetadata(
  client: CanvasClient,
  raw: RawCanvasCourse,
  fetchedAt: string,
  sisFetcher: SisFetcher,
): Promise<CourseMetadataRecord | null> {
  const courseId = asCourseId(raw.id);
  const courseName = raw.name?.trim();
  if (!courseId || !courseName) return null;

  const base = {
    course_id: courseId,
    course_name: courseName,
    term: raw.term?.name ?? null,
    canvas_course_code: raw.course_code ?? null,
    canvas_sis_course_id: raw.sis_course_id ?? null,
    canvas_account_name: raw.account?.name?.trim() || null,
    fetched_at: fetchedAt,
  };

  // Canvas teachers/account는 실제 enrollment·개설 조직 기반 사실값이라
  // SIS 응답에 없어도 채운다 (SIS에 이름이 있으면 SIS 우선).
  const canvasInstructor = raw.teachers?.[0]?.display_name?.trim() || null;
  const account = parseCanvasAccountName(base.canvas_account_name);

  const sis = await sisFetcher(client, courseId);
  if (sis.ok) {
    return {
      ...base,
      source: 'learningx_sis',
      // term도 SIS 확정값("2026-1")으로 통일한다. course_code/section과 같은
      // sis_source_id 출처라 한 레코드 내 형식이 일관된다(Canvas "2026년 1학기"는 폴백).
      term: sis.info.term ?? base.term,
      college: sis.info.college ?? account.college,
      department: sis.info.department ?? account.department,
      instructor: sis.info.instructor ?? canvasInstructor,
      course_code: sis.info.course_code,
      section: sis.info.section,
      sis_error: null,
    };
  }

  // SIS 실패 시에도 Canvas 원본 필드를 보존해 LLM이 직접 판단할 수 있게 한다.
  return {
    ...base,
    source: 'canvas_only',
    college: account.college,
    department: account.department,
    instructor: canvasInstructor,
    course_code: null,
    section: null,
    sis_error: `${sis.error_code}: ${sis.message}`,
  };
}

async function fetchCanvasCourse(client: CanvasClient, courseId: number): Promise<RawCanvasCourse> {
  return await client.fetchOne<RawCanvasCourse>(
    `/api/v1/courses/${courseId}?include[]=term&include[]=teachers&include[]=account`,
  );
}

async function fetchCanvasCourses(client: CanvasClient): Promise<RawCanvasCourse[]> {
  // include[]는 반복 키라 fetchAll params(Record)로 못 넘기므로 path에 직접 넣는다.
  return await client.fetchAll<RawCanvasCourse>('/api/v1/courses?include[]=term&include[]=teachers&include[]=account', {
    enrollment_state: 'active',
    per_page: '100',
  });
}

export async function syncCourseMetadata(
  cache: ExamCache,
  client: CanvasClient,
  input: { course_id?: number; force?: boolean } = {},
  sisFetcher: SisFetcher = fetchSisCourseInfo,
): Promise<SyncCourseMetadataResult> {
  const fetchedAt = new Date().toISOString();
  const errors: SyncCourseMetadataResult['errors'] = [];
  const synced: CourseMetadataRecord[] = [];

  if (input.course_id !== undefined && !input.force) {
    const cached = cache.getCourseMetadata(input.course_id);
    if (cached) return { ok: true, synced: [cached], errors };
  }

  try {
    const rawCourses = input.course_id !== undefined
      ? [await fetchCanvasCourse(client, input.course_id)]
      : await fetchCanvasCourses(client);
    for (const raw of rawCourses) {
      const metadata = await toMetadata(client, raw, fetchedAt, sisFetcher);
      if (metadata) synced.push(metadata);
    }
    cache.upsertCourseMetadata(synced);
  } catch (err) {
    errors.push({
      course_id: input.course_id,
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
    });
  }

  return { ok: synced.length > 0 || errors.length === 0, synced, errors };
}
