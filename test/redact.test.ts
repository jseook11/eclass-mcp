import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED,
  UNPARSEABLE_URL,
  redactHeaders,
  redactUrl,
  summarizeBody,
} from '../src/discovery/redact.js';

test('redactHeaders hides credential header values but keeps names', () => {
  const result = redactHeaders({
    Authorization: 'Bearer secret-token-123',
    Cookie: 'canvas_session=abc',
    'X-CSRF-Token': 'csrf-value',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });

  assert.equal(result['authorization'], REDACTED);
  assert.equal(result['cookie'], REDACTED);
  assert.equal(result['x-csrf-token'], REDACTED);
  assert.equal(result['content-type'], 'application/json');
  assert.equal(result['accept'], 'application/json');

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('secret-token-123'));
  assert.ok(!serialized.includes('canvas_session=abc'));
  assert.ok(!serialized.includes('csrf-value'));
});

test('redactUrl masks sensitive query params and keeps the rest', () => {
  const result = redactUrl(
    'https://eclass3.cau.ac.kr/files/1?access_token=tok123&verifier=ver456&page=2',
  );

  assert.ok(!result.includes('tok123'));
  assert.ok(!result.includes('ver456'));
  assert.ok(result.includes('page=2'));
  assert.ok(result.includes(`access_token=${encodeURIComponent(REDACTED)}`));
});

test('redactUrl never echoes an unparseable URL', () => {
  assert.equal(redactUrl('not a url with token=abc'), UNPARSEABLE_URL);
});

test('summarizeBody returns form field names without values', () => {
  const result = summarizeBody(
    'application/x-www-form-urlencoded',
    'authenticity_token=secret123&submission%5Bbody%5D=hello&utf8=1',
  );

  assert.equal(result?.kind, 'form');
  assert.deepEqual(result?.field_names.sort(), ['authenticity_token', 'submission[body]', 'utf8']);
  assert.ok(!JSON.stringify(result).includes('secret123'));
  assert.ok(!JSON.stringify(result).includes('hello'));
});

test('summarizeBody extracts multipart field names only', () => {
  const body =
    '------x\r\nContent-Disposition: form-data; name="attachment[uploaded_data]"; filename="a.pdf"\r\n\r\nFILEBYTES\r\n' +
    '------x\r\nContent-Disposition: form-data; name="authenticity_token"\r\n\r\ntok999\r\n------x--';
  const result = summarizeBody('multipart/form-data; boundary=----x', body);

  assert.equal(result?.kind, 'multipart');
  assert.deepEqual(result?.field_names.sort(), ['attachment[uploaded_data]', 'authenticity_token']);
  assert.ok(!JSON.stringify(result).includes('tok999'));
  assert.ok(!JSON.stringify(result).includes('FILEBYTES'));
});

test('summarizeBody returns top-level JSON keys without values', () => {
  const result = summarizeBody('application/json', JSON.stringify({ comment: 'hi', token: 'sec' }));

  assert.equal(result?.kind, 'json');
  assert.deepEqual(result?.field_names.sort(), ['comment', 'token']);
  assert.ok(!JSON.stringify(result).includes('sec"'));
  assert.ok(!JSON.stringify(result).includes('hi'));
});

test('summarizeBody returns null when there is no body', () => {
  assert.equal(summarizeBody('application/json', null), null);
  assert.equal(summarizeBody(null, ''), null);
});
