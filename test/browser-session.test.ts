import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import {
  buildCanvasTokenCompensationRetentionError,
  buildCanvasTokenRecoveryManualCleanupError,
  buildOcsCaptureFailureMessage,
  createCanvasTokenFromAuthenticatedPage,
  isSsoLoginUrl,
  listCanvasTokensFromAuthenticatedPage,
  parseCachedSessionCredential,
  parseLearningxBoardLocation,
  parseLearningxBoardPostAttachment,
  redactBrowserDiagnostic,
  revokeCanvasTokenFromAuthenticatedPage,
} from '../src/browser-session.js';
import { CANVAS_JSON_ACCEPT } from '../src/canvas-token-lifecycle.js';

test('LearningX board location parser accepts list and post-detail routes only', () => {
  assert.deepEqual(
    parseLearningxBoardLocation('https://eclass3.cau.ac.kr/learningx/lti/learningx_board/boards/77'),
    { boardId: '77' },
  );
  assert.deepEqual(
    parseLearningxBoardLocation('https://eclass3.cau.ac.kr/learningx/lti/learningx_board/boards/77/posts/901'),
    { boardId: '77', postId: '901' },
  );
  assert.equal(
    parseLearningxBoardLocation('https://attacker.example/learningx/lti/learningx_board/boards/77/posts/901'),
    null,
  );
});

test('LearningX board post parser selects a valid same-origin Canvas attachment', () => {
  assert.deepEqual(parseLearningxBoardPostAttachment({
    attachments: [
      { filename: 'bad.pdf', url: 'https://attacker.example/files/1/download', canvas_file_id: 1 },
      { filename: '  2026-02, 01.pdf  ', url: '/files/10683786/download?verifier=redacted' },
    ],
  }), {
    kind: 'file',
    url: 'https://eclass3.cau.ac.kr/files/10683786/download?verifier=redacted',
    type: 'pdf',
    filename: '2026-02, 01.pdf',
  });
});

test('LearningX board post parser rejects malformed attachment payloads', () => {
  assert.equal(parseLearningxBoardPostAttachment(null), null);
  assert.equal(parseLearningxBoardPostAttachment({ attachments: 'not-an-array' }), null);
  assert.equal(parseLearningxBoardPostAttachment({
    attachments: [{ filename: 'missing-file-id.pdf', url: '/courses/1' }],
  }), null);
});

test('browser token creation submits relative and absolute CAU profile form actions', async () => {
  const baseUrl = 'https://eclass3.cau.ac.kr';
  let formAction = `${baseUrl}/profile/tokens`;
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousWindow = runtime.window;
  const previousDocument = runtime.document;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const tokenForm = {
    get action() {
      return new URL(formAction, baseUrl).toString();
    },
    getAttribute: (name: string) => name === 'action' ? formAction : null,
    querySelector: (selector: string) =>
      selector === 'input[name="authenticity_token"]'
        ? { value: 'rails-authenticity-token' }
        : null,
  };
  runtime.window = { location: { origin: baseUrl, href: `${baseUrl}/profile/settings` } };
  runtime.document = {
    querySelector: (selector: string) =>
      selector === 'form[action$="/profile/tokens"]' ? tokenForm : null,
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return {
      ok: true,
      status: 200,
      url: new URL(String(input), baseUrl).toString(),
      text: async () => JSON.stringify({ id: 'new-id', token: 'new-secret' }),
    } as Response;
  }) as typeof fetch;
  const page = {
    url: () => `${baseUrl}/profile/settings`,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;

  try {
    const result = await createCanvasTokenFromAuthenticatedPage(
      page,
      '2026-10-11T00:00:00.000Z',
      'eclass-mcp test purpose',
    );

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, formAction);
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(
      new Headers(calls[0].init?.headers).get('Content-Type'),
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    assert.deepEqual(
      Object.fromEntries(new URLSearchParams(String(calls[0].init?.body))),
      {
        authenticity_token: 'rails-authenticity-token',
        'access_token[purpose]': 'eclass-mcp test purpose',
        'access_token[expires_at]': '2026-10-11T00:00:00.000Z',
      },
    );

    formAction = '/profile/tokens';
    await createCanvasTokenFromAuthenticatedPage(
      page,
      '2026-10-12T00:00:00.000Z',
      'eclass-mcp relative action',
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].input, `${baseUrl}/profile/tokens`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete runtime.window;
    else runtime.window = previousWindow;
    if (previousDocument === undefined) delete runtime.document;
    else runtime.document = previousDocument;
  }
});

test('SSO login URL detection includes the mportal authentication boundary', () => {
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do'),
    true,
  );
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do?returnUrl=%2Fstd'),
    true,
  );
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do/extra'),
    false,
  );
  assert.equal(
    isSsoLoginUrl('https://example.com/common/auth/newSsoLogin.do'),
    false,
  );
});

test('browser token recovery list/revoke calls are bounded and same-origin', async () => {
  const baseUrl = 'https://eclass3.cau.ac.kr';
  const runtime = globalThis as unknown as Record<string, unknown>;
  const previousWindow = runtime.window;
  const previousDocument = runtime.document;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  runtime.window = { location: { origin: baseUrl } };
  runtime.document = { querySelector: () => null };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const isDelete = init?.method === 'DELETE';
    return {
      ok: true,
      status: isDelete ? 204 : 200,
      url: `${baseUrl}${String(input)}`,
      text: async () => isDelete ? '' : JSON.stringify([{ id: 'listed-id' }]),
    } as Response;
  }) as typeof fetch;
  const page = {
    url: () => `${baseUrl}/profile/settings`,
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
  } as unknown as Page;

  try {
    assert.deepEqual(await listCanvasTokensFromAuthenticatedPage(page), [{ id: 'listed-id' }]);
    assert.equal(
      await revokeCanvasTokenFromAuthenticatedPage(page, { id: 'old/id' }),
      true,
    );

    assert.equal(calls[0].input, '/api/v1/users/self/user_generated_tokens?per_page=100');
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(new Headers(calls[0].init?.headers).get('Accept'), CANVAS_JSON_ACCEPT);
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.equal(calls[1].input, '/api/v1/users/self/tokens/old%2Fid');
    assert.equal(calls[1].init?.method, 'DELETE');
    assert.equal(calls[1].init?.redirect, 'error');
    assert.equal(calls[1].init?.credentials, 'same-origin');
    assert.equal(new Headers(calls[1].init?.headers).get('Accept'), CANVAS_JSON_ACCEPT);
    assert.ok(calls[1].init?.signal instanceof AbortSignal);

    const crossOriginPage = {
      url: () => 'https://attacker.example/profile/settings',
    } as unknown as Page;
    await assert.rejects(
      () => listCanvasTokensFromAuthenticatedPage(crossOriginPage),
      /authenticated same-origin page/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete runtime.window;
    else runtime.window = previousWindow;
    if (previousDocument === undefined) delete runtime.document;
    else runtime.document = previousDocument;
  }
});

test('failed compensation retention reports actionable manual cleanup without secrets', () => {
  const error = buildCanvasTokenCompensationRetentionError(
    new Error('operation included super-secret-token'),
    new Error('backend included another-secret'),
  );
  assert.match(error.message, /token may still be live/i);
  assert.match(error.message, /manually revoke.*Canvas profile settings/i);
  assert.doesNotMatch(error.message, /super-secret-token|another-secret/);
  assert.ok(error.cause instanceof AggregateError);
});

test('ambiguous token creation recovery requires exact manual Canvas review safely', () => {
  const error = buildCanvasTokenRecoveryManualCleanupError(
    new Error('transport mentioned super-secret-token'),
    new Error('selection mentioned private-purpose'),
  );
  assert.match(error.message, /exact issued token could not be identified and revoked safely/i);
  assert.match(error.message, /manually review Canvas profile settings/i);
  assert.doesNotMatch(error.message, /super-secret-token|private-purpose/);
  assert.ok(error.cause instanceof AggregateError);
});

test('session credential parsing distinguishes missing and corrupt cache values', () => {
  assert.equal(parseCachedSessionCredential(null), null);
  assert.equal(parseCachedSessionCredential('not-json'), null);
  assert.equal(parseCachedSessionCredential('[]'), null);
  assert.equal(parseCachedSessionCredential('{}'), null);
  assert.deepEqual(
    parseCachedSessionCredential('{"cookies":[],"origins":[]}'),
    { cookies: [], origins: [] },
  );
});

test('buildOcsCaptureFailureMessage includes OCS diagnostics', () => {
  const message = buildOcsCaptureFailureMessage({
    resourceId: '3647532',
    displayName: 'Y-생명지기.mp4',
    finalPageUrl: 'https://ocs.cau.ac.kr/em/69d860ed40663',
    pageTitle: 'OCS Viewer',
    recentFrames: ['https://ocs.cau.ac.kr/em/69d860ed40663'],
    recentRequests: ['GET media https://ocs.cau.ac.kr/media/video.m3u8'],
    recentResponses: ['200 media application/vnd.apple.mpegurl https://ocs.cau.ac.kr/media/video.m3u8'],
    mediaCandidates: ['[response:media:application/vnd.apple.mpegurl] https://ocs.cau.ac.kr/media/video.m3u8'],
    videoSources: ['blob:https://ocs.cau.ac.kr/abc'],
    iframeSources: ['https://ocs.cau.ac.kr/player/frame'],
  });

  assert.match(message, /OCS viewer loaded but no downloadable file response was captured/);
  assert.match(message, /resource_id: 3647532/);
  assert.match(message, /display_name: Y-생명지기\.mp4/);
  assert.match(message, /final page: https:\/\/ocs\.cau\.ac\.kr\/em\/69d860ed40663/);
  assert.match(message, /media candidates: \[response:media:application\/vnd\.apple\.mpegurl\] https:\/\/ocs\.cau\.ac\.kr\/media\/video\.m3u8/);
  assert.match(message, /video sources: blob:https:\/\/ocs\.cau\.ac\.kr\/abc/);
  assert.match(message, /iframe sources: https:\/\/ocs\.cau\.ac\.kr\/player\/frame/);
});

test('browser diagnostics redact signed and session-bearing URL queries', () => {
  const diagnostic = redactBrowserDiagnostic(
    '302 https://eclass3.cau.ac.kr/login?access_token=token-value&sig=signed-value&page=2 ' +
    '/relative?session=relative-session-value',
  );
  assert.doesNotMatch(diagnostic, /token-value|signed-value|relative-session-value/);
  assert.match(diagnostic, /page=2/);

  const message = buildOcsCaptureFailureMessage({
    resourceId: '1',
    displayName: 'file.pdf',
    finalPageUrl: 'https://ocs.cau.ac.kr/view?session=session-value',
    pageTitle: 'Viewer',
    recentFrames: ['https://ocs.cau.ac.kr/frame?verifier=verify-value'],
    recentRequests: ['GET https://ocs.cau.ac.kr/file?access_token=request-value'],
    recentResponses: ['302 https://ocs.cau.ac.kr/next?sig=response-value'],
    mediaCandidates: [],
    videoSources: [],
    iframeSources: ['/player?token=relative-frame-token'],
  });
  assert.doesNotMatch(
    message,
    /session-value|verify-value|request-value|response-value|relative-frame-token/,
  );
});
