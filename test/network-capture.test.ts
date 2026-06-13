import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NetworkRecorder,
  normalizePathPattern,
  summarizeEndpointCandidates,
  isTrackedDiscoveryUrl,
} from '../src/discovery/network-capture.js';
import type {
  CapturedEntry,
  NetworkSource,
  RequestLike,
  ResponseLike,
} from '../src/discovery/network-capture.js';
import { REDACTED } from '../src/discovery/redact.js';

type Listener<T> = (value: T) => void;

class FakeSource implements NetworkSource {
  private requestListeners: Listener<RequestLike>[] = [];
  private responseListeners: Listener<ResponseLike>[] = [];

  on(event: 'request', listener: Listener<RequestLike>): unknown;
  on(event: 'response', listener: Listener<ResponseLike>): unknown;
  on(event: 'request' | 'response', listener: Listener<RequestLike> | Listener<ResponseLike>): unknown {
    if (event === 'request') this.requestListeners.push(listener as Listener<RequestLike>);
    else this.responseListeners.push(listener as Listener<ResponseLike>);
    return this;
  }

  emitRequest(request: RequestLike): void {
    for (const listener of this.requestListeners) listener(request);
  }

  emitResponse(response: ResponseLike): void {
    for (const listener of this.responseListeners) listener(response);
  }
}

function fakeRequest(overrides: Partial<Record<'url' | 'method' | 'resourceType' | 'postData', string | null>> & {
  headers?: Record<string, string>;
} = {}): RequestLike {
  return {
    url: () => (overrides.url as string) ?? 'https://eclass3.cau.ac.kr/api/v1/courses/123',
    method: () => (overrides.method as string) ?? 'GET',
    resourceType: () => (overrides.resourceType as string) ?? 'xhr',
    headers: () => overrides.headers ?? { authorization: 'Bearer sek-token', 'content-type': 'application/json' },
    postData: () => (overrides.postData !== undefined ? overrides.postData : null),
  };
}

function fakeResponse(request: RequestLike, status = 200, headers: Record<string, string> = {}): ResponseLike {
  return {
    url: () => request.url(),
    status: () => status,
    headers: () => ({ 'content-type': 'application/json; charset=utf-8', ...headers }),
    request: () => request,
  };
}

test('NetworkRecorder captures redacted entries and enriches with response data', () => {
  const source = new FakeSource();
  const recorder = new NetworkRecorder();
  recorder.attach(source);

  const request = fakeRequest({
    url: 'https://eclass3.cau.ac.kr/api/v1/courses/123/assignments?access_token=tok777',
    method: 'POST',
    postData: 'authenticity_token=sek999&submission%5Bbody%5D=x',
    headers: {
      authorization: 'Bearer sek-token',
      cookie: 'canvas_session=sek-cookie',
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
  source.emitRequest(request);
  source.emitResponse(fakeResponse(request, 201));

  const entries = recorder.entries();
  assert.equal(entries.length, 1);
  const entry = entries[0];

  assert.equal(entry.method, 'POST');
  assert.equal(entry.status, 201);
  assert.equal(entry.response_content_type, 'application/json; charset=utf-8');
  assert.equal(entry.request_headers['authorization'], REDACTED);
  assert.equal(entry.request_headers['cookie'], REDACTED);
  assert.deepEqual(entry.request_body?.field_names.sort(), ['authenticity_token', 'submission[body]']);

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes('sek-token'));
  assert.ok(!serialized.includes('sek-cookie'));
  assert.ok(!serialized.includes('sek999'));
  assert.ok(!serialized.includes('tok777'));
});

test('NetworkRecorder ignores non-tracked origins by default', () => {
  const source = new FakeSource();
  const recorder = new NetworkRecorder();
  recorder.attach(source);

  source.emitRequest(fakeRequest({ url: 'https://example.com/api/data' }));
  source.emitRequest(fakeRequest({ url: 'https://ocs.cau.ac.kr/em/abc12345' }));

  const entries = recorder.entries();
  assert.equal(entries.length, 1);
  assert.ok(entries[0].url.startsWith('https://ocs.cau.ac.kr/'));
});

test('NetworkRecorder enforces maxEntries and counts dropped requests', () => {
  const source = new FakeSource();
  const recorder = new NetworkRecorder({ maxEntries: 2 });
  recorder.attach(source);

  for (let i = 0; i < 5; i += 1) {
    source.emitRequest(fakeRequest({ url: `https://eclass3.cau.ac.kr/api/v1/items/${i}` }));
  }

  assert.equal(recorder.entries().length, 2);
  assert.equal(recorder.droppedCount(), 3);
});

test('normalizePathPattern collapses numeric, hex and uuid segments', () => {
  assert.equal(
    normalizePathPattern('/courses/123/assignments/4567'),
    '/courses/:id/assignments/:id',
  );
  assert.equal(normalizePathPattern('/em/69d860ed40663'), '/em/:id');
  assert.equal(
    normalizePathPattern('/files/0f8fad5b-d9cb-469f-a165-70867728950e/download'),
    '/files/:id/download',
  );
  assert.equal(normalizePathPattern('/api/v1/users/self'), '/api/v1/users/self');
});

test('summarizeEndpointCandidates groups by method and path pattern', () => {
  const entries: CapturedEntry[] = [
    {
      method: 'GET',
      url: 'https://eclass3.cau.ac.kr/api/v1/courses/1/assignments/10',
      resource_type: 'xhr',
      request_headers: {},
      request_body: null,
      status: 200,
      response_content_type: 'application/json; charset=utf-8',
    },
    {
      method: 'GET',
      url: 'https://eclass3.cau.ac.kr/api/v1/courses/2/assignments/20',
      resource_type: 'fetch',
      request_headers: {},
      request_body: null,
      status: 304,
    },
    {
      method: 'POST',
      url: 'https://eclass3.cau.ac.kr/api/v1/courses/1/assignments/10/submissions',
      resource_type: 'xhr',
      request_headers: {},
      request_body: { kind: 'form', field_names: ['submission[body]'] },
      status: 201,
    },
    {
      method: 'GET',
      url: 'https://eclass3.cau.ac.kr/static/app.js',
      resource_type: 'script',
      request_headers: {},
      request_body: null,
      status: 200,
    },
  ];

  const candidates = summarizeEndpointCandidates(entries);

  assert.equal(candidates.length, 2);
  const getCandidate = candidates.find((c) => c.method === 'GET');
  const postCandidate = candidates.find((c) => c.method === 'POST');

  assert.equal(getCandidate?.path_pattern, '/api/v1/courses/:id/assignments/:id');
  assert.equal(getCandidate?.count, 2);
  assert.deepEqual(getCandidate?.statuses.sort(), [200, 304]);
  assert.deepEqual(getCandidate?.content_types, ['application/json']);

  assert.equal(postCandidate?.path_pattern, '/api/v1/courses/:id/assignments/:id/submissions');
  assert.deepEqual(postCandidate?.request_body_fields, ['submission[body]']);
});

test('isTrackedDiscoveryUrl allows mportal2 and rpt80', () => {
  assert.equal(isTrackedDiscoveryUrl('https://mportal2.cau.ac.kr/std/usk/sUskSif002/selectList.ajax'), true);
  assert.equal(isTrackedDiscoveryUrl('https://rpt80.cau.ac.kr/oz80/ozhViewer2.jsp'), true);
});
