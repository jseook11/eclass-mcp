import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOcsCaptureFailureMessage } from '../src/browser-session.js';

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
