import test from 'node:test';
import assert from 'node:assert/strict';

import { getGrades } from '../src/tools/get-grades.js';
import { getAssignmentDetail, deriveHasSubmitted } from '../src/tools/get-assignment-detail.js';

// Minimal CanvasClient stub driven by a path → response map.
function makeClient(routes: Record<string, unknown>): any {
  return {
    getToken: () => 'tok',
    async fetchAll<T>(path: string, params?: Record<string, string>): Promise<T[]> {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      const key = path + qs;
      const match = routes[key] ?? routes[path];
      if (match === undefined) throw new Error(`unexpected fetchAll ${key}`);
      return match as T[];
    },
    async fetchOne<T>(path: string): Promise<T> {
      const match = routes[path];
      if (match === undefined) throw new Error(`unexpected fetchOne ${path}`);
      return match as T;
    },
  };
}

const COURSES_PATH = '/api/v1/courses?enrollment_state=active&include%5B%5D=total_scores&per_page=50';

test('getGrades returns course-level scores from enrollments', async () => {
  const client = makeClient({
    [COURSES_PATH]: [
      {
        id: '1',
        name: '물리',
        enrollments: [{ type: 'student', computed_current_score: 88.5, computed_current_grade: null, computed_final_score: 80, computed_final_grade: null }],
      },
    ],
    '/api/v1/courses/1/assignments?include%5B%5D=submission&per_page=100': [
      { id: '10', name: '과제1', points_possible: 10, submission: { score: 9, grade: '9', submitted_at: '2026-03-01T00:00:00Z', workflow_state: 'graded', graded_at: '2026-03-02T00:00:00Z' } },
      { id: '11', name: '과제2', points_possible: 10, submission: { score: null, workflow_state: 'unsubmitted' } },
    ],
  });

  const result = await getGrades(client, 1, true);
  assert.equal(result.ok, true);
  assert.equal(result.courses.length, 1);
  const c = result.courses[0];
  assert.equal(c.current_score, 88.5);
  assert.equal(c.final_score, 80);
  assert.equal(c.assignments?.length, 2);
  assert.equal(c.assignments?.[0].submitted, true);
  assert.equal(c.assignments?.[0].score, 9);
  assert.equal(c.assignments?.[1].submitted, false);
});

test('getGrades records per-course assignment failure as partial error', async () => {
  const client = makeClient({
    [COURSES_PATH]: [
      { id: '1', name: '물리', enrollments: [{ type: 'student', computed_current_score: 50 }] },
    ],
    // assignments route intentionally missing → throws inside fetchAssignmentScores
  });

  const result = await getGrades(client, 1, true);
  assert.equal(result.courses.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].scope, 'course:1');
});

test('getGrades skips assignment fetch when include_assignments is false', async () => {
  const client = makeClient({
    [COURSES_PATH]: [
      { id: '1', name: '물리', enrollments: [{ type: 'student', computed_current_score: 50 }] },
    ],
  });
  const result = await getGrades(client, 1, false);
  assert.equal(result.courses[0].assignments, undefined);
  assert.equal(result.errors.length, 0);
});

test('getAssignmentDetail maps fields and derives has_submitted', async () => {
  const client = makeClient({
    '/api/v1/courses/1/assignments/10?include[]=submission': {
      id: '10',
      name: '레포트',
      due_at: '2026-04-01T14:59:59Z',
      unlock_at: '2026-03-01T00:00:00Z',
      lock_at: '2026-04-01T14:59:59Z',
      points_possible: 100,
      grading_type: 'points',
      submission_types: ['online_upload'],
      allowed_extensions: ['pdf', 'hwp'],
      allowed_attempts: -1,
      html_url: 'https://eclass3.cau.ac.kr/courses/1/assignments/10',
      submission: { submitted_at: '2026-03-20T05:00:00Z', attempt: 1, workflow_state: 'submitted', score: null },
    },
  });

  const result = await getAssignmentDetail(client, 1, 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.assignment.name, '레포트');
  assert.deepEqual(result.assignment.submission_types, ['online_upload']);
  assert.deepEqual(result.assignment.allowed_extensions, ['pdf', 'hwp']);
  assert.equal(result.assignment.allowed_attempts, -1);
  assert.equal(result.assignment.has_submitted, true);
  assert.ok(result.assignment.due_at?.endsWith('+09:00'));
});

test('getAssignmentDetail returns structured 404 error', async () => {
  const client = {
    getToken: () => 'tok',
    async fetchOne(): Promise<never> { throw new Error('Canvas API error 404'); },
    async fetchAll(): Promise<never[]> { return []; },
  } as any;

  const result = await getAssignmentDetail(client, 1, 999);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error_code, 'ASSIGNMENT_NOT_FOUND');
  assert.equal(result.retryable, false);
});

test('deriveHasSubmitted handles states and nulls', () => {
  assert.equal(deriveHasSubmitted(null), false);
  assert.equal(deriveHasSubmitted({ workflow_state: 'unsubmitted' }), false);
  assert.equal(deriveHasSubmitted({ workflow_state: 'graded' }), true);
  assert.equal(deriveHasSubmitted({ submitted_at: '2026-01-01T00:00:00Z' }), true);
});
