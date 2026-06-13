import { CanvasClient } from '../canvas-client.js';
import { parseIsoToKst } from '../time.js';
import { sanitizeDebug, isRetryableReason } from '../errors.js';

export interface AssignmentScore {
  assignment_id: number;
  name: string;
  score: number | null;
  grade: string | null;
  points_possible: number | null;
  submitted: boolean;
  submitted_at: string | null;
  graded_at: string | null;
  workflow_state: string | null;
}

export interface CourseGrade {
  course_id: number;
  course_name: string;
  current_score: number | null;
  current_grade: string | null;
  final_score: number | null;
  final_grade: string | null;
  assignments?: AssignmentScore[];
}

export interface GradesError {
  scope: string;          // 'courses' or `course:<id>`
  reason: string;
  retryable: boolean;
}

export interface GetGradesResult {
  ok: boolean;
  courses: CourseGrade[];
  errors: GradesError[];
}

interface RawEnrollment {
  type?: string;
  computed_current_score?: number | null;
  computed_current_grade?: string | null;
  computed_final_score?: number | null;
  computed_final_grade?: string | null;
}

interface RawCourse {
  id: number | string;
  name?: string;
  enrollments?: RawEnrollment[];
}

interface RawSubmission {
  submitted_at?: string | null;
  workflow_state?: string | null;
  score?: number | null;
  grade?: string | null;
  graded_at?: string | null;
}

interface RawAssignment {
  id: number | string;
  name?: string;
  points_possible?: number | null;
  submission?: RawSubmission | null;
}

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);

function pickStudentEnrollment(enrollments: RawEnrollment[] | undefined): RawEnrollment | null {
  if (!Array.isArray(enrollments) || enrollments.length === 0) return null;
  return enrollments.find((e) => e.type === 'student') ?? enrollments[0];
}

function toIssue(scope: string, err: unknown): GradesError {
  const reason = sanitizeDebug(err instanceof Error ? err.message : String(err)) || 'Unknown error';
  return { scope, reason, retryable: isRetryableReason(reason) };
}

async function fetchAssignmentScores(client: CanvasClient, courseId: number): Promise<AssignmentScore[]> {
  const raw = await client.fetchAll<RawAssignment>(
    `/api/v1/courses/${courseId}/assignments`,
    { 'include[]': 'submission', per_page: '100' },
  );
  return raw.map((a) => {
    const submission = a.submission ?? null;
    const submitted = Boolean(
      submission?.submitted_at ||
      (submission?.workflow_state && SUBMITTED_STATES.has(submission.workflow_state)),
    );
    return {
      assignment_id: Number(a.id),
      name: a.name ?? '',
      score: submission?.score ?? null,
      grade: submission?.grade ?? null,
      points_possible: a.points_possible ?? null,
      submitted,
      submitted_at: parseIsoToKst(submission?.submitted_at),
      graded_at: parseIsoToKst(submission?.graded_at),
      workflow_state: submission?.workflow_state ?? null,
    };
  });
}

export async function getGrades(
  client: CanvasClient,
  courseId?: number,
  includeAssignments: boolean = true,
): Promise<GetGradesResult> {
  const errors: GradesError[] = [];

  // Course-level scores via total_scores enrollment include
  let rawCourses: RawCourse[];
  try {
    rawCourses = await client.fetchAll<RawCourse>('/api/v1/courses', {
      enrollment_state: 'active',
      'include[]': 'total_scores',
      per_page: '50',
    });
  } catch (err) {
    return { ok: false, courses: [], errors: [toIssue('courses', err)] };
  }

  const filtered = courseId !== undefined
    ? rawCourses.filter((c) => Number(c.id) === courseId)
    : rawCourses.filter((c) => (c.name ?? '').trim() !== '');

  const courses: CourseGrade[] = [];

  for (const raw of filtered) {
    const enrollment = pickStudentEnrollment(raw.enrollments);
    const grade: CourseGrade = {
      course_id: Number(raw.id),
      course_name: (raw.name ?? '').trim(),
      current_score: enrollment?.computed_current_score ?? null,
      current_grade: enrollment?.computed_current_grade ?? null,
      final_score: enrollment?.computed_final_score ?? null,
      final_grade: enrollment?.computed_final_grade ?? null,
    };
    courses.push(grade);
  }

  if (includeAssignments) {
    await Promise.all(
      courses.map(async (course) => {
        try {
          course.assignments = await fetchAssignmentScores(client, course.course_id);
        } catch (err) {
          errors.push(toIssue(`course:${course.course_id}`, err));
        }
      }),
    );
  }

  return {
    ok: courses.length > 0 || errors.length === 0,
    courses,
    errors,
  };
}
