import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createEclassServer } from '../src/server.js';
import { checkEclassCoursesApi } from '../src/doctor.js';
import { getCourses } from '../src/tools/get-courses.js';
import type { BrowserSession } from '../src/browser-session.js';
import { CanvasClient } from '../src/canvas-client.js';
import type { ExamCache } from '../src/exam-cache.js';
import type { FileCache } from '../src/file-cache.js';

type RawFixture = Record<string, unknown>;

function fakeCanvas(raw: RawFixture[]): {
  client: CanvasClient;
  calls: Array<{ path: string; params?: Record<string, string> }>;
} {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const client = {
    async fetchAll(path: string, params?: Record<string, string>) {
      calls.push({ path, params });
      return raw;
    },
  } as unknown as CanvasClient;
  return { client, calls };
}

const NOW = new Date('2026-08-26T12:00:00+09:00');
const CURRENT_TERM_ID = 'term-current';
const PREVIOUS_TERM_ID = 'term-previous';
const FUTURE_TERM_ID = 'term-future';

test('getCourses normalizes Canvas string IDs and rejects invalid public IDs', async () => {
  const { client, calls } = fakeCanvas([
    { id: '123456', name: '  강의 A  ' },
    { id: 42, name: '강의 B' },
    { id: 'not-a-number', name: '잘못된 ID' },
    { id: 0, name: '0 ID' },
    { id: -1, name: '음수 ID' },
    { id: 1.5, name: '소수 ID' },
    { id: '9007199254740992', name: '안전하지 않은 ID' },
    { id: 99, name: '   ' },
  ]);

  const courses = await getCourses(client, { scope: 'all', now: NOW });

  assert.deepEqual(courses, [
    { id: 123456, name: '강의 A' },
    { id: 42, name: '강의 B' },
  ]);
  assert.deepEqual(calls, [{
    path: '/api/v1/courses?include[]=term&include[]=concluded&state[]=available&state[]=completed',
    params: {
      enrollment_state: 'active',
      per_page: '100',
    },
  }]);
});

test('getCourses requests available and completed workflow states outside current scope', async () => {
  const allFixture = fakeCanvas([{ id: '1', name: '완료 상태의 활성 수강 이력' }]);
  await getCourses(allFixture.client, { scope: 'all', now: NOW });
  assert.match(allFixture.calls[0]?.path ?? '', /state\[\]=available&state\[\]=completed$/);

  const trainingFixture = fakeCanvas([{ id: '2', name: '비교과 과정: 예방교육' }]);
  await getCourses(trainingFixture.client, { scope: 'training', now: NOW });
  assert.match(trainingFixture.calls[0]?.path ?? '', /state\[\]=available&state\[\]=completed$/);

  const currentFixture = fakeCanvas([{
    id: '3',
    name: '현재 강의',
    term: { id: CURRENT_TERM_ID, name: '2026년 2학기' },
  }]);
  await getCourses(currentFixture.client, { scope: 'current', now: NOW });
  assert.match(currentFixture.calls[0]?.path ?? '', /state\[\]=available$/);
  assert.doesNotMatch(currentFixture.calls[0]?.path ?? '', /state\[\]=completed/);
});

test('getCourses serializes repeated Canvas include and state query parameters', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new CanvasClient('https://eclass3.cau.ac.kr', 'test-token');
    await getCourses(client, { scope: 'all', now: NOW });
    const url = new URL(requestedUrl);
    assert.deepEqual(url.searchParams.getAll('include[]'), ['term', 'concluded']);
    assert.deepEqual(url.searchParams.getAll('state[]'), ['available', 'completed']);
    assert.equal(url.searchParams.get('enrollment_state'), 'active');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getCourses selects the newest eligible academic term and excludes supplemental courses', async () => {
  const currentTerm = {
    id: CURRENT_TERM_ID,
    name: '2026년 2학기',
    start_at: '2026-09-01T00:00:00+09:00',
    end_at: '2026-12-31T23:59:59+09:00',
  };
  const oldTerm = { id: PREVIOUS_TERM_ID, name: '2026년 1학기', start_at: null, end_at: null };
  const raw: RawFixture[] = [
    { id: '150001', name: '현재 교과목 A', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    { id: '150002', name: '현재 교과목 B', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    { id: '150003', name: '현재 교과목 C', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    { id: '150004', name: '현재 교과목 D', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    { id: '150005', name: '현재 교과목 E', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    // Canvas can omit the expanded term object while retaining enrollment_term_id.
    { id: '150006', name: '현재 교과목 F', enrollment_term_id: CURRENT_TERM_ID, term: null },
    { id: '150008', name: '비교과 과정: 필수 예방교육', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm },
    { id: '140001', name: '이전 학기 교과목', enrollment_term_id: PREVIOUS_TERM_ID, term: oldTerm },
    {
      id: '250001',
      name: '비교과 과정: 연중 예방교육',
      enrollment_term_id: 'training-2026',
      term: {
        id: 'training-2026',
        name: '2026 연중교육',
        start_at: '2026-08-25T00:00:00+09:00',
        end_at: '2026-12-31T23:59:59+09:00',
      },
    },
    { id: '250002', name: '비교과 과정: 온라인 예방 교육', term: null },
    {
      id: '160001',
      name: '너무 이른 미래 강의',
      enrollment_term_id: FUTURE_TERM_ID,
      term: {
        id: FUTURE_TERM_ID,
        name: '2027년 1학기',
        start_at: '2027-03-01T00:00:00+09:00',
        end_at: '2027-06-30T23:59:59+09:00',
      },
    },
    { id: '150007', name: '종료 처리된 강의', enrollment_term_id: CURRENT_TERM_ID, term: currentTerm, concluded: true },
  ];

  const { client } = fakeCanvas(raw);
  const courses = await getCourses(client, { scope: 'current', now: NOW });

  assert.deepEqual(courses.map((course) => course.id), [
    150001,
    150002,
    150003,
    150004,
    150005,
    150006,
  ]);
});

test('getCourses resolves date-less term names and includes every matching Canvas term ID', async () => {
  const { client } = fakeCanvas([
    { id: '1', name: '이전 강의', enrollment_term_id: PREVIOUS_TERM_ID, term: { id: PREVIOUS_TERM_ID, name: '2026-1' } },
    { id: '2', name: '현재 A', enrollment_term_id: CURRENT_TERM_ID, term: { id: CURRENT_TERM_ID, name: '2026년 2학기' } },
    { id: '3', name: '현재 B', enrollment_term_id: 'term-current-alt', term: { id: 'term-current-alt', name: '2026_2' } },
  ]);

  const courses = await getCourses(client, { scope: 'current', now: NOW });
  assert.deepEqual(courses.map((course) => course.id), [2, 3]);
});

test('getCourses retains a selected date-only cohort without term IDs', async () => {
  const { client } = fakeCanvas([{
    id: '1',
    name: '날짜로만 판별한 현재 강의',
    start_at: '2026-08-01T00:00:00+09:00',
    end_at: '2026-12-31T23:59:59+09:00',
  }]);

  const courses = await getCourses(client, { scope: 'current', now: NOW });
  assert.deepEqual(courses, [{ id: 1, name: '날짜로만 판별한 현재 강의' }]);
});

test('getCourses exposes mandatory training separately without keyword false positives', async () => {
  const { client } = fakeCanvas([
    { id: '10', name: '비교과 과정: 온라인 예방 교육', term: null },
    { id: '11', name: '비교과 과정: 법정 의무 교육', term: null },
    { id: '12', name: '일반 교과목: 예방 키워드', term: null },
    { id: '13', name: '비교과 과정: 필수 예방교육', term: { id: CURRENT_TERM_ID, name: '2026년 2학기' } },
    { id: '14', name: '일반 교과목: 폭력 예방 키워드', term: { id: CURRENT_TERM_ID, name: '2026년 2학기' } },
  ]);

  const training = await getCourses(client, { scope: 'training', now: NOW });
  const all = await getCourses(client, { scope: 'all', now: NOW });
  const current = await getCourses(client, { scope: 'current', now: NOW });

  assert.deepEqual(training.map((course) => course.id), [10, 11, 13]);
  assert.deepEqual(all.map((course) => course.id), [10, 11, 12, 13, 14]);
  assert.deepEqual(current.map((course) => course.id), [14]);
});

test('getCourses fails closed when no current academic term can be resolved', async () => {
  const { client } = fakeCanvas([
    { id: '10', name: '비교과 과정: 예방 교육', term: null },
    { id: '11', name: '비교과 과정: 학술정보 활용교육', term: null },
  ]);

  await assert.rejects(
    () => getCourses(client, { scope: 'current', now: NOW }),
    /CURRENT_TERM_UNRESOLVED/,
  );
});

test('doctor checks course API health without requiring current-term inference', async () => {
  const { client, calls } = fakeCanvas([
    { id: '10', name: '비교과 과정: 예방교육', term: null },
  ]);
  const session = { getClient: async () => client } as unknown as BrowserSession;

  const result = await checkEclassCoursesApi(session);

  assert.deepEqual(result, {
    name: 'eclass courses API',
    ok: true,
    detail: 'active enrollments: 1',
  });
  assert.match(calls[0]?.path ?? '', /state\[\]=available&state\[\]=completed$/);
});

test('eclass_get_courses satisfies its MCP output schema for Canvas string IDs', async () => {
  const canvas = {
    async fetchAll() {
      return [{
        id: '123456',
        name: '현재 교과목 A',
        enrollment_term_id: CURRENT_TERM_ID,
        term: {
          id: CURRENT_TERM_ID,
          name: '2026년 2학기',
          start_at: '2026-08-20T00:00:00+09:00',
          end_at: '2026-12-31T23:59:59+09:00',
        },
      }];
    },
  } as unknown as CanvasClient;
  const session = { getClient: async () => canvas } as unknown as BrowserSession;
  let cached: Array<{ id: number; name: string }> = [];
  const fileCache = {
    upsertCourses(courses: Array<{ id: number; name: string }>) {
      cached = courses;
    },
    replaceCurrentCourses(courses: Array<{ id: number; name: string }>) {
      cached = courses;
    },
  } as unknown as FileCache;
  const server = createEclassServer({
    username: 'test',
    session,
    fileCache,
    examCache: {} as ExamCache,
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    // listTools makes the SDK cache and enforce the advertised output schema.
    await client.listTools();
    const result = await client.callTool({ name: 'eclass_get_courses', arguments: {} });
    assert.deepEqual(result.structuredContent, {
      result: [{ id: 123456, name: '현재 교과목 A' }],
    });
    assert.deepEqual(cached, [{ id: 123456, name: '현재 교과목 A' }]);
  } finally {
    await client.close();
    await server.close();
  }
});
