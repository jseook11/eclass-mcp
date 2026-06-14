import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_HANDOFF_MAX_BYTES,
  buildFileHandoff,
  handoffFile,
  inferMimeType,
  resolveHandoffMaxBytes,
} from '../src/tools/file-handoff.js';
import type { HandoffDeps } from '../src/tools/file-handoff.js';
import type { DownloadRecord } from '../src/file-cache.js';

const baseRecord: DownloadRecord = {
  file_id: 'f1',
  course_id: 10,
  display_name: '3주차 강의자료.pdf',
  local_path: '/d/10/week3.pdf',
  downloaded_at: '2026-03-01T00:00:00.000Z',
  size_bytes: 5,
};

function depsWith(over: Partial<HandoffDeps>): HandoffDeps {
  return {
    getRecord: () => baseRecord,
    statSize: () => 5,
    readFile: () => Buffer.from('hello'),
    maxBytes: DEFAULT_HANDOFF_MAX_BYTES,
    ...over,
  };
}

test('inferMimeType maps known extensions case-insensitively', () => {
  assert.equal(inferMimeType('a.pdf'), 'application/pdf');
  assert.equal(inferMimeType('A.PDF'), 'application/pdf');
  assert.equal(inferMimeType('notes.txt'), 'text/plain');
  assert.equal(inferMimeType('sheet.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(inferMimeType('report.hwp'), 'application/x-hwp');
});

test('inferMimeType falls back to octet-stream for unknown/extensionless', () => {
  assert.equal(inferMimeType('archive.xyz'), 'application/octet-stream');
  assert.equal(inferMimeType('README'), 'application/octet-stream');
});

test('buildFileHandoff encodes bytes as base64 with inferred mime', () => {
  const bytes = Buffer.from('hello');
  const result = buildFileHandoff(baseRecord, bytes);
  assert.equal(result.structuredContent.delivered, true);
  assert.equal(result.structuredContent.file_id, 'f1');
  assert.equal(result.structuredContent.mime_type, 'application/pdf');
  assert.equal(result.structuredContent.size_bytes, 5);
  assert.equal(result.content.length, 1);
  const [block] = result.content;
  assert.equal(block.type, 'resource');
  assert.equal(block.resource.mimeType, 'application/pdf');
  assert.equal(block.resource.blob, bytes.toString('base64'));
});

test('buildFileHandoff percent-encodes the uri but decodes back to the readable name', () => {
  const result = buildFileHandoff({ ...baseRecord, display_name: '확률통계 3주차.pdf' }, Buffer.from('x'));
  const { uri } = result.content[0].resource;
  // RFC 유효: 공백 없음 + ASCII만(비ASCII는 percent-encode됨).
  assert.ok(!/\s/.test(uri), `uri should have no spaces: ${uri}`);
  assert.ok(/^[\x00-\x7F]+$/.test(uri), `uri should be ASCII-only: ${uri}`);
  // 디코딩하면 읽기 좋은 원래 파일명으로 복원된다.
  assert.equal(decodeURI(uri), 'file:///확률통계 3주차.pdf');
  // display_name은 원형 그대로 보존.
  assert.equal(result.structuredContent.display_name, '확률통계 3주차.pdf');
});

test('buildFileHandoff falls back to file-<id> when display_name sanitizes to null', () => {
  const result = buildFileHandoff({ ...baseRecord, display_name: '..' }, Buffer.from('x'));
  assert.equal(result.content[0].resource.uri, 'file:///file-f1');
});

test('resolveHandoffMaxBytes uses default when unset or invalid', () => {
  assert.equal(resolveHandoffMaxBytes({}), DEFAULT_HANDOFF_MAX_BYTES);
  assert.equal(resolveHandoffMaxBytes({ ECLASS_HANDOFF_MAX_BYTES: 'abc' }), DEFAULT_HANDOFF_MAX_BYTES);
  assert.equal(resolveHandoffMaxBytes({ ECLASS_HANDOFF_MAX_BYTES: '0' }), DEFAULT_HANDOFF_MAX_BYTES);
});

test('resolveHandoffMaxBytes honors a positive override', () => {
  assert.equal(resolveHandoffMaxBytes({ ECLASS_HANDOFF_MAX_BYTES: '1048576' }), 1048576);
});

test('handoffFile returns not_found when record is absent', () => {
  const out = handoffFile('missing', depsWith({ getRecord: () => undefined }));
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error.code, 'not_found');
});

test('handoffFile returns file_missing when disk file is gone', () => {
  const out = handoffFile('f1', depsWith({ statSize: () => null }));
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error.code, 'file_missing');
});

test('handoffFile returns too_large without reading the file', () => {
  let read = false;
  const out = handoffFile('f1', depsWith({
    getRecord: () => ({ ...baseRecord, size_bytes: 100 }),
    maxBytes: 50,
    readFile: () => {
      read = true;
      return Buffer.from('x');
    },
  }));
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error.code, 'too_large');
  assert.equal(read, false);
});

test('handoffFile uses disk size when DB size_bytes is 0', () => {
  const out = handoffFile('f1', depsWith({
    getRecord: () => ({ ...baseRecord, size_bytes: 0 }),
    statSize: () => 100,
    maxBytes: 50,
  }));
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.error.code, 'too_large');
});

test('handoffFile returns ok result for an in-limit file', () => {
  const out = handoffFile('f1', depsWith({}));
  assert.equal(out.ok, true);
  assert.equal(out.ok === true && out.result.structuredContent.delivered, true);
});
