import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSession } from '../src/browser-session.js';
import { parseResourceItems } from '../src/resource-items.js';

// API_PLAN: API-first courseresource가 실패하면 Playwright intercept로 폴백한다.

function makeInterceptPage(items: unknown) {
  return {
    on() {},
    async goto() {},
    url: () => 'https://eclass3.cau.ac.kr/courses/1/external_tools/3',
    async title() { return ''; },
    isClosed: () => false,
    waitForResponse: () => Promise.resolve({ json: async () => items }),
  };
}

test('interceptCourseresource falls back to Playwright when the API path throws', async () => {
  const session = new BrowserSession('tester', async () => 'pw');
  let apiCalls = 0;
  let playwrightUsed = false;
  (session as any).getClient = async () => ({});
  (session as any).ensurePlaywrightReady = async () => {};
  (session as any).courseResourceApiFetcher = async () => {
    apiCalls += 1;
    throw new Error('LearningX API error 500');
  };
  (session as any).withAuthenticatedContext = async (
    _label: string,
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => {
    playwrightUsed = true;
    return fn({
      newPage: async () => makeInterceptPage([{ id: '7', title: '강의자료', url: 'https://eclass3.cau.ac.kr/files/7', type: 'file' }]),
      on() {},
    });
  };

  const items = await session.interceptCourseresource(1);

  assert.equal(apiCalls, 1);
  assert.equal(playwrightUsed, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '7');
});

test('interceptCourseresource skips Playwright when the API path succeeds', async () => {
  const session = new BrowserSession('tester', async () => 'pw');
  let playwrightUsed = false;
  (session as any).getClient = async () => ({});
  (session as any).courseResourceApiFetcher = async () => [{ id: '1', title: 'api', url: null, type: 'file' }];
  (session as any).withAuthenticatedContext = async () => {
    playwrightUsed = true;
    return [];
  };

  const items = await session.interceptCourseresource(1);

  assert.equal(playwrightUsed, false);
  assert.equal(items.length, 1);
});

test('parseResourceItems strict mode throws on unexpected shape (API → fallback trigger)', () => {
  assert.throws(() => parseResourceItems({ unexpected: true }, { strict: true }), /resources_db/);
  // 비-strict(인터셉트 경로)는 기존처럼 빈 배열 유지
  assert.deepEqual(parseResourceItems({ unexpected: true }), []);
});
