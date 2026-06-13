import test from 'node:test';
import assert from 'node:assert/strict';

import { getAssignments } from '../src/tools/get-assignments.js';
import type { CanvasClient } from '../src/canvas-client.js';

function mockClient(
  fetchAll: (path: string, params?: Record<string, string>) => Promise<unknown[]>,
): CanvasClient {
  return { fetchAll } as CanvasClient;
}

test('getAssignments with course_id uses course assignments API and returns assignment metadata', async () => {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = mockClient(async (path, params) => {
    calls.push({ path, params });
    return [
      {
        id: '10',
        name: '보고서',
        due_at: '2099-06-20T12:00:00Z',
        created_at: '2099-06-01T12:00:00Z',
        html_url: 'https://eclass3.cau.ac.kr/courses/1/assignments/10',
        submission_types: ['online_upload'],
        allowed_extensions: ['pdf', 'hwp'],
        allowed_attempts: -1,
        submission: { submitted_at: null, workflow_state: 'unsubmitted', missing: false },
      },
    ];
  });

  const result = await getAssignments(client, 1, 30, true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/courses/1/assignments');
  assert.deepEqual(calls[0].params, { 'include[]': 'submission', per_page: '100' });
  assert.equal(result.length, 1);
  assert.equal(result[0].assignment_id, 10);
  assert.deepEqual(result[0].submission_types, ['online_upload']);
  assert.deepEqual(result[0].allowed_extensions, ['pdf', 'hwp']);
  assert.equal(result[0].allowed_attempts, -1);
});

test('getAssignments course API honors include_submitted=false', async () => {
  const client = mockClient(async () => [
    {
      id: 10,
      name: 'submitted',
      due_at: '2099-06-20T12:00:00Z',
      submission: { submitted_at: '2099-06-12T12:00:00Z', workflow_state: 'submitted' },
    },
    {
      id: 11,
      name: 'todo',
      due_at: '2099-06-21T12:00:00Z',
      submission: { submitted_at: null, workflow_state: 'unsubmitted' },
    },
  ]);

  const result = await getAssignments(client, 1, 30, false);

  assert.deepEqual(result.map((assignment) => assignment.title), ['todo']);
});

test('getAssignments without course_id keeps planner API behavior', async () => {
  const calls: string[] = [];
  const client = mockClient(async (path) => {
    calls.push(path);
    return [
      {
        plannable_type: 'assignment',
        plannable: { title: 'Planner task', due_at: '2099-06-20T12:00:00Z', created_at: '2099-06-01T12:00:00Z' },
        html_url: '/courses/1/assignments/10',
        submissions: { submitted: false, missing: false },
        context_name: '물리',
        course_id: 1,
      },
    ];
  });

  const result = await getAssignments(client, undefined, 30, true);

  assert.deepEqual(calls, ['/api/v1/planner/items']);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Planner task');
  assert.equal(result[0].assignment_id, undefined);
});
