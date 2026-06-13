import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { submitAssignment } from '../src/tools/submit-assignment.js';

function rawAssignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '10',
    name: '레포트',
    due_at: null,
    unlock_at: null,
    lock_at: '2099-12-31T14:59:59Z',
    points_possible: 100,
    grading_type: 'points',
    submission_types: ['online_upload'],
    allowed_extensions: ['pdf'],
    allowed_attempts: -1,
    html_url: 'https://eclass3.cau.ac.kr/courses/1/assignments/10',
    submission: { submitted_at: null, attempt: null, workflow_state: 'unsubmitted' },
    ...overrides,
  };
}

async function makeTempFile(extension = 'pdf'): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'submit-'));
  const filePath = path.join(dir, `report.${extension}`);
  await fs.writeFile(filePath, Buffer.from([1, 2, 3]));
  return { dir, filePath };
}

function makeSession() {
  const calls: Array<{ courseId: number; assignmentId: number; filePaths: string[]; comment?: string }> = [];
  return {
    calls,
    async submitAssignmentViaUi(courseId: number, assignmentId: number, filePaths: string[], comment?: string): Promise<void> {
      calls.push({ courseId, assignmentId, filePaths, comment });
    },
  };
}

function makeClient(assignments: unknown[], postFormImpl?: (path: string, form: URLSearchParams) => Promise<unknown>) {
  const fetchOneCalls: string[] = [];
  const postFormCalls: Array<{ path: string; keys: string[] }> = [];
  return {
    fetchOneCalls,
    postFormCalls,
    getToken: () => 'secret-token',
    async fetchAll(): Promise<never[]> { return []; },
    async fetchOne<T>(path: string): Promise<T> {
      fetchOneCalls.push(path);
      const next = assignments.shift();
      if (next === undefined) throw new Error(`unexpected fetchOne ${path}`);
      return next as T;
    },
    async postForm<T>(path: string, form: URLSearchParams): Promise<T> {
      postFormCalls.push({ path, keys: Array.from(form.keys()) });
      if (postFormImpl) return await postFormImpl(path, form) as T;
      return {} as T;
    },
  };
}

test('submitAssignment dry_run performs validation without submission calls', async () => {
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([rawAssignment()]);
  const session = makeSession();

  try {
    const result = await submitAssignment(client as any, session, {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, 'dry_run');
    assert.equal(result.strategy, 'canvas_api');
    assert.equal(client.postFormCalls.length, 0);
    assert.equal(session.calls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment rejects unsupported external_tool assignments', async () => {
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([rawAssignment({ submission_types: ['external_tool'] })]);

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'ASSIGNMENT_SUBMISSION_UNSUPPORTED_TYPE');
    assert.equal(result.retryable, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment rejects disallowed file extensions', async () => {
  const { dir, filePath } = await makeTempFile('hwp');
  const client = makeClient([rawAssignment({ allowed_extensions: ['pdf'] })]);

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'ASSIGNMENT_EXTENSION_NOT_ALLOWED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment requires confirm_resubmit for already submitted assignments', async () => {
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([
    rawAssignment({
      submission: { submitted_at: '2026-06-12T07:50:37Z', attempt: 2, workflow_state: 'submitted' },
    }),
  ]);

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'ASSIGNMENT_ALREADY_SUBMITTED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment rejects missing local files', async () => {
  const result = await submitAssignment(makeClient([]) as any, makeSession(), {
    course_id: 1,
    assignment_id: 10,
    file_paths: ['/tmp/does-not-exist-eclass-submit.pdf'],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error_code, 'SUBMISSION_FILE_NOT_FOUND');
});

test('submitAssignment submits online_upload through Canvas API and verifies status', async () => {
  const originalFetch = globalThis.fetch;
  const { dir, filePath } = await makeTempFile();
  const uploadCalls: string[] = [];
  const client = makeClient([
    rawAssignment(),
    rawAssignment({ submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' } }),
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) {
      return {
        upload_url: 'https://kr.object.gov-ncloudstorage.com/upload',
        upload_params: { key: 'uploads/report.pdf', Policy: 'policy' },
      };
    }
    return { ok: true };
  });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    uploadCalls.push(url);
    return new Response(JSON.stringify({ id: 555 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      dry_run: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, 'submitted');
    assert.equal(result.strategy, 'canvas_api');
    assert.equal(result.verification?.checked, true);
    assert.equal(result.attempt, 1);
    assert.deepEqual(uploadCalls, ['https://kr.object.gov-ncloudstorage.com/upload']);
    assert.equal(client.postFormCalls[0].path, '/api/v1/courses/1/assignments/10/submissions/self/files');
    assert.equal(client.postFormCalls[1].path, '/api/v1/courses/1/assignments/10/submissions');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment falls back to UI when Canvas upload API fails', async () => {
  const { dir, filePath } = await makeTempFile();
  const session = makeSession();
  const client = makeClient([
    rawAssignment(),
    rawAssignment({ submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' } }),
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) throw new Error('Canvas API error 500');
    return { ok: true };
  });

  try {
    const result = await submitAssignment(client as any, session, {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      comment: '확인 부탁드립니다.',
      dry_run: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.strategy, 'playwright_ui');
    assert.equal(session.calls.length, 1);
    assert.equal(session.calls[0].courseId, 1);
    assert.equal(session.calls[0].assignmentId, 10);
    assert.deepEqual(session.calls[0].filePaths, [filePath]);
    assert.equal(session.calls[0].comment, '확인 부탁드립니다.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment reports verification failure when status is not submitted', async () => {
  const originalFetch = globalThis.fetch;
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([
    rawAssignment(),
    rawAssignment(),
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) {
      return {
        upload_url: 'https://kr.object.gov-ncloudstorage.com/upload',
        upload_params: { key: 'uploads/report.pdf' },
      };
    }
    return { ok: true };
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 555 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      dry_run: false,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'SUBMISSION_VERIFICATION_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment rejects assignments outside the unlock/lock window', async () => {
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([rawAssignment({ lock_at: '2000-01-01T00:00:00Z' })]);

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'ASSIGNMENT_LOCKED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment submits online_text_entry through Canvas API', async () => {
  const client = makeClient([
    rawAssignment({ submission_types: ['online_text_entry'], allowed_extensions: [] }),
    rawAssignment({
      submission_types: ['online_text_entry'],
      allowed_extensions: [],
      submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' },
    }),
  ]);
  const session = makeSession();

  const result = await submitAssignment(client as any, session, {
    course_id: 1,
    assignment_id: 10,
    body: '서술형 답안입니다.',
    dry_run: false,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.mode, 'submitted');
  assert.equal(result.strategy, 'canvas_api');
  assert.equal(session.calls.length, 0);
  assert.equal(client.postFormCalls.length, 1);
  assert.equal(client.postFormCalls[0].path, '/api/v1/courses/1/assignments/10/submissions');
  assert.ok(client.postFormCalls[0].keys.includes('submission[body]'));
});

test('submitAssignment follows upload redirect and finalizes with bearer token', async () => {
  const originalFetch = globalThis.fetch;
  const { dir, filePath } = await makeTempFile();
  const fetchCalls: Array<{ url: string; auth: string | null }> = [];
  const client = makeClient([
    rawAssignment(),
    rawAssignment({ submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' } }),
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) {
      return {
        upload_url: 'https://kr.object.gov-ncloudstorage.com/upload',
        upload_params: { key: 'uploads/report.pdf' },
      };
    }
    return { ok: true };
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    if (url.startsWith('https://kr.object.gov-ncloudstorage.com/')) {
      return new Response(null, {
        status: 303,
        headers: { location: 'https://eclass3.cau.ac.kr/api/v1/files/555/create_success?uuid=abc' },
      });
    }
    return new Response(JSON.stringify({ id: 555 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      dry_run: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.strategy, 'canvas_api');
    assert.equal(fetchCalls.length, 2);
    // 스토리지 업로드에는 토큰을 보내지 않고, finalize GET에만 Bearer를 보낸다
    assert.equal(fetchCalls[0].auth, null);
    assert.ok(fetchCalls[1].url.startsWith('https://eclass3.cau.ac.kr/api/v1/files/555/create_success'));
    assert.equal(fetchCalls[1].auth, 'Bearer secret-token');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment does not double-submit when submit POST fails but submission landed', async () => {
  const originalFetch = globalThis.fetch;
  const { dir, filePath } = await makeTempFile();
  const session = makeSession();
  const submitted = rawAssignment({ submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' } });
  const client = makeClient([
    rawAssignment(),  // before
    submitted,        // recheck after ambiguous failure → 제출이 이미 반영됨
    submitted,        // post-submit verification
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) {
      return {
        upload_url: 'https://kr.object.gov-ncloudstorage.com/upload',
        upload_params: { key: 'uploads/report.pdf' },
      };
    }
    throw new Error('socket hang up');  // 제출 POST의 응답 처리 실패 (서버에는 반영됨)
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 555 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await submitAssignment(client as any, session, {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      dry_run: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mode, 'submitted');
    assert.equal(result.strategy, 'canvas_api');
    // 핵심: UI 폴백으로 두 번째 제출을 하지 않는다
    assert.equal(session.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment falls back to UI when submit POST fails and submission did not land', async () => {
  const originalFetch = globalThis.fetch;
  const { dir, filePath } = await makeTempFile();
  const session = makeSession();
  const client = makeClient([
    rawAssignment(),  // before
    rawAssignment(),  // recheck → 제출 미반영 확인 → 폴백 안전
    rawAssignment({ submission: { submitted_at: '2026-06-12T08:00:00Z', attempt: 1, workflow_state: 'submitted' } }),  // verification
  ], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) {
      return {
        upload_url: 'https://kr.object.gov-ncloudstorage.com/upload',
        upload_params: { key: 'uploads/report.pdf' },
      };
    }
    throw new Error('Canvas API error 500');
  });
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 555 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await submitAssignment(client as any, session, {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
      dry_run: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.strategy, 'playwright_ui');
    assert.equal(session.calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment refuses UI fallback for multi-file uploads', async () => {
  const { dir, filePath } = await makeTempFile();
  const secondPath = path.join(dir, 'appendix.pdf');
  await fs.writeFile(secondPath, Buffer.from([4, 5, 6]));
  const session = makeSession();
  const client = makeClient([rawAssignment()], async (postPath) => {
    if (postPath.endsWith('/submissions/self/files')) throw new Error('Canvas API error 500');
    return { ok: true };
  });

  try {
    const result = await submitAssignment(client as any, session, {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath, secondPath],
      dry_run: false,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error_code, 'SUBMISSION_UPLOAD_FAILED');
    assert.equal(session.calls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('submitAssignment result does not include token, cookie, or file bytes', async () => {
  const { dir, filePath } = await makeTempFile();
  const client = makeClient([rawAssignment()]);

  try {
    const result = await submitAssignment(client as any, makeSession(), {
      course_id: 1,
      assignment_id: 10,
      file_paths: [filePath],
    });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes('secret-token'), false);
    assert.equal(/cookie/i.test(serialized), false);
    assert.equal(serialized.includes('[1,2,3]'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
