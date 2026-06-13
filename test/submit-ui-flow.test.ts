import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSession } from '../src/browser-session.js';

// PHASE5 §5: 모킹된 page로 UI 제출 셀렉터 순서 검증
// (.submit_assignment_link → file input → comment → turnitin_pledge → 제출 버튼)

function makeMockPage(events: string[]) {
  function makeLocator(name: string) {
    return {
      first() { return this; },
      async isVisible() { return true; },
      async click() { events.push(`click:${name}`); },
      async setInputFiles(files: string[]) { events.push(`files:${files.length}`); },
      async fill(_value: string) { events.push(`fill:${name}`); },
      async check() { events.push(`check:${name}`); },
    };
  }

  return {
    async goto(_url: string) { events.push('goto'); },
    url: () => 'https://eclass3.cau.ac.kr/courses/1/assignments/10',
    isClosed: () => false,
    locator(selector: string) {
      if (selector.includes('submit_assignment_link')) return makeLocator('open');
      if (selector.includes('uploaded_data')) return makeLocator('file-input');
      if (selector.includes('submission[comment]')) return makeLocator('comment');
      if (selector.includes('turnitin_pledge')) return makeLocator('pledge');
      if (selector.includes('과제 제출')) return makeLocator('submit');
      return makeLocator(selector);
    },
    waitForResponse: () => Promise.resolve({ ok: () => true, status: () => 200 }),
  };
}

function makePatchedSession(events: string[]) {
  const session = new BrowserSession('tester', async () => 'pw');
  const page = makeMockPage(events);
  (session as any).ensurePlaywrightReady = async () => {};
  (session as any).getClient = async () => ({});
  (session as any).withAuthenticatedContext = async (
    _label: string,
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => fn({ newPage: async () => page });
  return session;
}

test('submitAssignmentViaUi drives the confirmed selectors in order', async () => {
  const events: string[] = [];
  const session = makePatchedSession(events);

  await session.submitAssignmentViaUi(1, 10, ['/tmp/report.pdf'], '검토 부탁드립니다');

  assert.deepEqual(events, [
    'goto',
    'click:open',
    'files:1',
    'fill:comment',
    'check:pledge',
    'click:submit',
  ]);
});

test('submitAssignmentViaUi skips comment fill when no comment given', async () => {
  const events: string[] = [];
  const session = makePatchedSession(events);

  await session.submitAssignmentViaUi(1, 10, ['/tmp/report.pdf']);

  assert.deepEqual(events, [
    'goto',
    'click:open',
    'files:1',
    'check:pledge',
    'click:submit',
  ]);
});
