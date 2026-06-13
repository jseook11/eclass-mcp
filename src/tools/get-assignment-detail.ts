import { CanvasClient } from '../canvas-client.js';
import { parseIsoToKst } from '../time.js';
import { toErrorResult } from '../errors.js';
import type { ToolErrorResult } from '../errors.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';

export interface AssignmentDetail {
  ok: true;
  assignment: {
    id: number;
    course_id: number;
    name: string;
    due_at: string | null;
    unlock_at: string | null;
    lock_at: string | null;
    points_possible: number | null;
    grading_type: string | null;
    submission_types: string[];
    allowed_extensions: string[];
    allowed_attempts: number | null;   // -1 means unlimited in Canvas
    has_submitted: boolean;
    submitted_at: string | null;
    attempt: number | null;
    workflow_state: string | null;     // submission workflow state
    score: number | null;
    grade: string | null;
    graded_at: string | null;
    html_url: string | null;
  };
}

interface RawSubmission {
  submitted_at?: string | null;
  attempt?: number | null;
  workflow_state?: string | null;
  score?: number | null;
  grade?: string | null;
  graded_at?: string | null;
}

interface RawAssignment {
  id?: number | string;
  name?: string;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  points_possible?: number | null;
  grading_type?: string | null;
  submission_types?: string[];
  allowed_extensions?: string[];
  allowed_attempts?: number | null;
  html_url?: string | null;
  submission?: RawSubmission | null;
}

const SUBMITTED_STATES = new Set(['submitted', 'graded', 'pending_review']);

export function deriveHasSubmitted(submission: RawSubmission | null | undefined): boolean {
  if (!submission) return false;
  if (submission.submitted_at) return true;
  if (submission.workflow_state && SUBMITTED_STATES.has(submission.workflow_state)) return true;
  return false;
}

export async function getAssignmentDetail(
  client: CanvasClient,
  courseId: number,
  assignmentId: number,
): Promise<AssignmentDetail | ToolErrorResult> {
  let raw: RawAssignment;
  try {
    raw = await client.fetchOne<RawAssignment>(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}?include[]=submission`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(reason)) {
      return toErrorResult(
        'ASSIGNMENT_NOT_FOUND',
        '해당 과제를 찾을 수 없습니다. course_id 또는 assignment_id를 확인하세요.',
        { err, retryable: false, nextAction: 'eclass_get_assignments로 과제 목록을 확인하세요.' },
      );
    }
    return toErrorResult('ASSIGNMENT_DETAIL_FETCH_FAILED', '과제 상세 정보를 가져오지 못했습니다.', { err });
  }

  const submission = raw.submission ?? null;

  return {
    ok: true,
    assignment: {
      id: Number(raw.id),
      course_id: courseId,
      name: raw.name ?? '',
      due_at: parseIsoToKst(raw.due_at),
      unlock_at: parseIsoToKst(raw.unlock_at),
      lock_at: parseIsoToKst(raw.lock_at),
      points_possible: raw.points_possible ?? null,
      grading_type: raw.grading_type ?? null,
      submission_types: Array.isArray(raw.submission_types) ? raw.submission_types : [],
      allowed_extensions: Array.isArray(raw.allowed_extensions) ? raw.allowed_extensions : [],
      allowed_attempts: raw.allowed_attempts ?? null,
      has_submitted: deriveHasSubmitted(submission),
      submitted_at: parseIsoToKst(submission?.submitted_at),
      attempt: submission?.attempt ?? null,
      workflow_state: submission?.workflow_state ?? null,
      score: submission?.score ?? null,
      grade: submission?.grade ?? null,
      graded_at: parseIsoToKst(submission?.graded_at),
      html_url: raw.html_url ? (raw.html_url.startsWith('http') ? raw.html_url : BASE_URL + raw.html_url) : null,
    },
  };
}
