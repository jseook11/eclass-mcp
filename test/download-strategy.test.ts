import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDownloadStrategy, isPlaywrightStrategy, isDirectStrategy } from '../src/download-strategy.js';

test('resolveDownloadStrategy classifies streaming media as unsupported', () => {
  assert.equal(resolveDownloadStrategy('https://eclass3.cau.ac.kr/x', 'mp4'), 'unsupported_streaming_media');
  assert.equal(resolveDownloadStrategy(null, 'video'), 'unsupported_streaming_media');
  assert.equal(resolveDownloadStrategy('https://x/y.m3u8', 'hls'), 'unsupported_streaming_media');
});

test('resolveDownloadStrategy maps null url to playwright_ui', () => {
  assert.equal(resolveDownloadStrategy(null, 'pdf'), 'playwright_ui');
  assert.equal(resolveDownloadStrategy(undefined), 'playwright_ui');
  assert.equal(resolveDownloadStrategy(''), 'playwright_ui');
});

test('resolveDownloadStrategy maps OCS viewer url to ocs_intercept', () => {
  assert.equal(resolveDownloadStrategy('https://ocs.cau.ac.kr/em/69d860ed40663', 'pdf'), 'ocs_intercept');
});

test('resolveDownloadStrategy maps eclass3 url to canvas_file', () => {
  assert.equal(resolveDownloadStrategy('https://eclass3.cau.ac.kr/files/123/download', 'application/pdf'), 'canvas_file');
});

test('resolveDownloadStrategy maps other hosts to direct_url', () => {
  assert.equal(resolveDownloadStrategy('https://files.example.com/a.pdf'), 'direct_url');
  assert.equal(resolveDownloadStrategy('not-a-url'), 'direct_url');
});

test('strategy group helpers', () => {
  assert.ok(isPlaywrightStrategy('ocs_intercept'));
  assert.ok(isPlaywrightStrategy('playwright_ui'));
  assert.ok(!isPlaywrightStrategy('canvas_file'));
  assert.ok(isDirectStrategy('canvas_file'));
  assert.ok(isDirectStrategy('direct_url'));
  assert.ok(!isDirectStrategy('ocs_intercept'));
});
