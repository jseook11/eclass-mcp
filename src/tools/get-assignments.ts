import { CanvasClient } from '../canvas-client.js';
import type { Assignment } from '../types.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';

const KST_OFFSET = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

function toKstIso(dt: Date): string {
  // Shift UTC epoch to KST, then read UTC fields to get KST wall-clock time
  const kst = new Date(dt.getTime() + KST_OFFSET);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T` +
         `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}.000+09:00`;
}

function parseIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return null;
  return toKstIso(dt);
}

interface RawPlannable {
  title?: string;
  due_at?: string | null;
  created_at?: string | null;
  course_id?: number;
}

interface RawSubmissions {
  submitted?: boolean;
  missing?: boolean;
}

interface RawPlannerItem {
  plannable_type: string;
  plannable: RawPlannable;
  html_url?: string | null;
  submissions?: RawSubmissions | null;
  context_name?: string;
  course_id?: number;
}

interface RawCourseAssignmentSubmission {
  submitted_at?: string | null;
  workflow_state?: string | null;
  missing?: boolean | null;
}

interface RawCourseAssignment {
  id: number | string;
  name?: string;
  due_at?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  course_id?: number;
  submission?: RawCourseAssignmentSubmission | null;
  submission_types?: string[];
  allowed_extensions?: string[] | null;
  allowed_attempts?: number | null;
}

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);

function isSubmitted(submission: RawCourseAssignmentSubmission | null | undefined): boolean {
  return Boolean(
    submission?.submitted_at ||
    (submission?.workflow_state && SUBMITTED_STATES.has(submission.workflow_state)),
  );
}

function isRecentAssignment(createdAt: string | null, dueAt: string | null, cutoffStr: string, nowStr: string): boolean {
  return (
    (createdAt !== null && createdAt >= cutoffStr) ||
    (dueAt !== null && dueAt > nowStr)
  );
}

function isMissingAssignment(dueAt: string | null, submitted: boolean, explicitMissing?: boolean | null, nowStr?: string): boolean {
  if (explicitMissing !== undefined && explicitMissing !== null) return explicitMissing;
  return Boolean(dueAt && nowStr && dueAt < nowStr && !submitted);
}

async function getCourseAssignments(
  client: CanvasClient,
  courseId: number,
  includeSubmitted: boolean,
  cutoffStr: string,
  nowStr: string,
): Promise<Assignment[]> {
  const raw = await client.fetchAll<RawCourseAssignment>(
    `/api/v1/courses/${courseId}/assignments`,
    { 'include[]': 'submission', per_page: '100' },
  );

  const assignments: Assignment[] = [];
  for (const item of raw) {
    const title = (item.name ?? '').trim();
    if (!title) continue;

    const due_at = parseIso(item.due_at);
    const created_at = parseIso(item.created_at);
    if (!isRecentAssignment(created_at, due_at, cutoffStr, nowStr)) continue;

    const submitted = isSubmitted(item.submission);
    if (!includeSubmitted && submitted) continue;
    const assignmentId = Number(item.id);

    assignments.push({
      ...(Number.isFinite(assignmentId) ? { assignment_id: assignmentId } : {}),
      title,
      course_name: '',
      due_at,
      is_submitted: submitted,
      is_missing: isMissingAssignment(due_at, submitted, item.submission?.missing, nowStr),
      url: item.html_url ?? `${BASE_URL}/courses/${courseId}/assignments/${item.id}`,
      submission_types: item.submission_types ?? [],
      allowed_extensions: item.allowed_extensions ?? [],
      allowed_attempts: item.allowed_attempts ?? null,
    });
  }
  return assignments;
}

export async function getAssignments(
  client: CanvasClient,
  courseId?: number,
  daysAhead: number = 30,
  includeSubmitted: boolean = true,
): Promise<Assignment[]> {
  const now = new Date();

  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  // Comparison strings: parseIso returns UTC relabeled as +09:00, so compare in same format.
  // Both sides are produced by the same parseIso, so lexicographic order is consistent.
  const cutoffStr = toKstIso(startDate);
  const nowStr = toKstIso(now);

  if (courseId !== undefined) {
    return getCourseAssignments(client, courseId, includeSubmitted, cutoffStr, nowStr);
  }

  const raw = await client.fetchAll<RawPlannerItem>('/api/v1/planner/items', {
    start_date: startDate.toISOString().split('T')[0],
    end_date: endDate.toISOString().split('T')[0],
    order: 'asc',
    per_page: '100',
  });

  const assignments: Assignment[] = [];

  for (const item of raw) {
    if (item.plannable_type !== 'assignment' && item.plannable_type !== 'quiz') {
      continue;
    }

    const plannable = item.plannable ?? {};
    const title = (plannable.title ?? '').trim();
    const html_url = item.html_url ?? '';
    const full_url = html_url ? BASE_URL + html_url : null;

    const due_at = parseIso(plannable.due_at);
    const created_at = parseIso(plannable.created_at);

    // Only include recent: created within 7 days OR due in the future
    if (!isRecentAssignment(created_at, due_at, cutoffStr, nowStr)) continue;

    const submissions = item.submissions ?? {};
    const is_submitted = Boolean(submissions.submitted);
    const is_missing = Boolean(submissions.missing);

    if (!includeSubmitted && is_submitted) continue;

    const course_name = item.context_name ?? '';

    assignments.push({
      title,
      course_name,
      due_at,
      is_submitted,
      is_missing,
      url: full_url,
    });
  }

  return assignments;
}
