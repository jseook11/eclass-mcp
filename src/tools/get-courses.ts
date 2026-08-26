import { CanvasClient } from '../canvas-client.js';
import type { Course } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKAHEAD_DAYS = 45;
const DEFAULT_LOOKBACK_DAYS = 240;

interface RawTerm {
  id?: number | string | null;
  name?: string | null;
  end_at?: string | null;
  start_at?: string | null;
}

interface RawCourse {
  id: number | string;
  name?: string | null;
  course_code?: string | null;
  sis_course_id?: string | null;
  enrollment_term_id?: number | string | null;
  start_at?: string | null;
  end_at?: string | null;
  concluded?: boolean | null;
  term?: RawTerm | null;
}

export type CourseScope = 'current' | 'all' | 'training';

export interface GetCoursesOptions {
  scope?: CourseScope;
  /** Injectable clock for deterministic filtering tests. */
  now?: Date;
  /** Include an upcoming academic term shortly before classes begin. */
  lookaheadDays?: number;
}

interface AcademicTermKey {
  year: number;
  semester: 1 | 2;
  canonical: string;
  rank: number;
}

interface NormalizedCourse {
  course: Course;
  concluded: boolean;
  enrollmentTermId: string | null;
  termId: string | null;
  termKey: AcademicTermKey | null;
  startAt: number | null;
  endAt: number | null;
}

interface TermCohort {
  id: string;
  canonical: string | null;
  rank: number | null;
  score: number;
  termIds: Set<string>;
}

export class CurrentTermUnresolvedError extends Error {
  readonly code = 'CURRENT_TERM_UNRESOLVED';

  constructor() {
    super('CURRENT_TERM_UNRESOLVED: 현재 학기를 판별할 수 없습니다. available/completed 활성 수강 이력은 scope="all"로 조회하세요.');
    this.name = 'CurrentTermUnresolvedError';
  }
}

function normalizeCourseId(value: unknown): number | null {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOpaqueId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses only explicit academic-term formats. In particular, `2026-10-...`
 * is not interpreted as semester 1 because the semester digit must be bounded.
 */
export function parseAcademicTerm(value: string | null | undefined): AcademicTermKey | null {
  if (!value) return null;
  const text = value.trim();
  const korean = text.match(/(?:^|\D)(20\d{2})\s*(?:년|학년도)\s*([12])\s*학기(?:\D|$)/);
  const delimited = text.match(/(?:^|\D)(20\d{2})\s*[-_.]\s*([12])(?:\D|$)/);
  const match = korean ?? delimited;
  if (!match) return null;
  const year = Number(match[1]);
  const semester = Number(match[2]) as 1 | 2;
  return {
    year,
    semester,
    canonical: `${year}-${semester}`,
    rank: year * 10 + semester,
  };
}

function nominalTermStart(term: AcademicTermKey): number {
  // CAU regular semesters begin around March and September. This timestamp is
  // used only when Canvas omits term dates; explicit dates always win.
  return Date.UTC(term.year, term.semester === 1 ? 2 : 8, 1);
}

function normalizedDates(raw: RawCourse): { startAt: number | null; endAt: number | null } {
  let startAt = parseDate(raw.term?.start_at) ?? parseDate(raw.start_at);
  let endAt = parseDate(raw.term?.end_at) ?? parseDate(raw.end_at);
  if (startAt !== null && endAt !== null && startAt > endAt) {
    startAt = null;
    endAt = null;
  }
  return { startAt, endAt };
}

function normalizeCourse(raw: RawCourse): NormalizedCourse | null {
  const id = normalizeCourseId(raw.id);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (id === null || name === '') return null;

  const termKey = parseAcademicTerm(raw.term?.name)
    ?? parseAcademicTerm(raw.course_code)
    ?? parseAcademicTerm(raw.sis_course_id);
  const { startAt, endAt } = normalizedDates(raw);
  return {
    course: { id, name },
    concluded: raw.concluded === true,
    enrollmentTermId: normalizeOpaqueId(raw.enrollment_term_id),
    termId: normalizeOpaqueId(raw.term?.id) ?? normalizeOpaqueId(raw.enrollment_term_id),
    termKey,
    startAt,
    endAt,
  };
}

function isEligibleForCurrentTerm(
  item: NormalizedCourse,
  now: number,
  lookahead: number,
  lookback: number,
): boolean {
  if (item.concluded) return false;
  if (isTrainingCourse(item)) return false;
  if (item.endAt !== null && item.endAt < now) return false;

  const effectiveStart = item.startAt ?? (item.termKey ? nominalTermStart(item.termKey) : null);
  if (effectiveStart === null) return false;
  if (effectiveStart > now + lookahead) return false;
  if (item.endAt === null && effectiveStart < now - lookback) return false;
  return true;
}

function cohortId(item: NormalizedCourse): string | null {
  if (item.termKey) return `term:${item.termKey.canonical}`;
  if (item.termId && (item.startAt !== null || item.endAt !== null)) return `id:${item.termId}`;
  if (item.startAt !== null || item.endAt !== null) return `dates:${item.startAt ?? ''}:${item.endAt ?? ''}`;
  return null;
}

function selectCurrentCourses(
  courses: NormalizedCourse[],
  now: number,
  lookaheadDays: number,
): Course[] {
  const lookahead = Math.max(0, lookaheadDays) * DAY_MS;
  const lookback = DEFAULT_LOOKBACK_DAYS * DAY_MS;
  const cohorts = new Map<string, TermCohort>();

  for (const item of courses) {
    if (!isEligibleForCurrentTerm(item, now, lookahead, lookback)) continue;
    const id = cohortId(item);
    if (!id) continue;
    const score = item.startAt ?? (item.termKey ? nominalTermStart(item.termKey) : Number.NEGATIVE_INFINITY);
    const existing = cohorts.get(id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (item.termId) existing.termIds.add(item.termId);
      continue;
    }
    cohorts.set(id, {
      id,
      canonical: item.termKey?.canonical ?? null,
      rank: item.termKey?.rank ?? null,
      score,
      termIds: new Set(item.termId ? [item.termId] : []),
    });
  }

  const candidates = [...cohorts.values()];
  const semanticCandidates = candidates.filter((cohort) => cohort.canonical !== null);
  // Once Canvas exposes a recognizable academic term, a generic date-only
  // cohort (often long-running supplemental education) must not outrank it.
  const selectionPool = semanticCandidates.length > 0 ? semanticCandidates : candidates;
  const selected = selectionPool.sort((a, b) => {
    if (a.rank !== b.rank) {
      return (b.rank ?? Number.NEGATIVE_INFINITY) - (a.rank ?? Number.NEGATIVE_INFINITY);
    }
    return b.score - a.score;
  })[0];
  if (!selected) throw new CurrentTermUnresolvedError();

  return courses
    .filter((item) => {
      if (item.concluded) return false;
      if (isTrainingCourse(item)) return false;
      if (item.endAt !== null && item.endAt < now) return false;
      if (cohortId(item) === selected.id) return true;
      if (selected.canonical && item.termKey?.canonical === selected.canonical) return true;
      const termId = item.termId ?? item.enrollmentTermId;
      return termId !== null && selected.termIds.has(termId);
    })
    .map((item) => item.course);
}

const TRAINING_PATTERNS = [
  /예방\s*교육/u,
  /예방교육/u,
  /인권경영(?:\s*\d+)?/u,
  /생명지킴이/u,
  /학술정보\s*활용교육/u,
  /연구실\s*안전\s*교육/u,
  /장애\s*인식\s*개선\s*교육/u,
  /법정\s*의무\s*교육/u,
];

function isTrainingCourse(item: NormalizedCourse): boolean {
  // A subject title that merely contains "예방" must remain academic; the
  // configured patterns require a stronger training-specific phrase.
  return TRAINING_PATTERNS.some((pattern) => pattern.test(item.course.name));
}

function resolveOptions(input: GetCoursesOptions | boolean): Required<GetCoursesOptions> {
  if (typeof input === 'boolean') {
    return {
      scope: input ? 'current' : 'all',
      now: new Date(),
      lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    };
  }
  return {
    scope: input.scope ?? 'current',
    now: input.now ?? new Date(),
    lookaheadDays: input.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS,
  };
}

/**
 * Fetches active-enrollment courses. The default `current` scope returns only
 * the resolved academic term. Use `all` for available/completed active
 * enrollments or `training` for conservatively classified mandatory education.
 */
export async function getCourses(
  client: CanvasClient,
  options: GetCoursesOptions | boolean = {},
): Promise<Course[]> {
  const resolved = resolveOptions(options);
  // Repeated include[] keys must live in the path because fetchAll parameters
  // are represented as a Record<string, string>.
  const params: Record<string, string> = {
    enrollment_state: 'active',
    per_page: '100',
  };
  // Canvas defaults student/observer requests to `available` when state[] is
  // omitted. Repeat the query key in the path so all/training can also retain
  // completed course workflows from the active-enrollment history.
  const workflowStates = resolved.scope === 'current'
    ? '&state[]=available'
    : '&state[]=available&state[]=completed';

  const raw = await client.fetchAll<RawCourse>(
    `/api/v1/courses?include[]=term&include[]=concluded${workflowStates}`,
    params,
  );
  const normalized = raw
    .map(normalizeCourse)
    .filter((course): course is NormalizedCourse => course !== null);

  if (resolved.scope === 'all') return normalized.map((item) => item.course);
  if (resolved.scope === 'training') {
    return normalized.filter(isTrainingCourse).map((item) => item.course);
  }
  if (raw.length === 0) return [];
  return selectCurrentCourses(
    normalized,
    resolved.now.getTime(),
    resolved.lookaheadDays,
  );
}
