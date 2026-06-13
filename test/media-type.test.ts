import test from 'node:test';
import assert from 'node:assert/strict';

import { isStreamingMediaType } from '../src/browser-session.js';

test('isStreamingMediaType matches known video and stream types', () => {
  assert.equal(isStreamingMediaType('mp4'), true);
  assert.equal(isStreamingMediaType('video/mp4'), true);
  assert.equal(isStreamingMediaType('m3u8'), true);
  assert.equal(isStreamingMediaType('movie'), true);
});

test('isStreamingMediaType does not block document types', () => {
  assert.equal(isStreamingMediaType('pdf'), false);
  assert.equal(isStreamingMediaType('application/pdf'), false);
  assert.equal(isStreamingMediaType('ppt'), false);
  assert.equal(isStreamingMediaType(undefined), false);
});
