import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDoctorResult } from '../src/chatgptui/doctor.js';

test('classifyDoctorResult tolerates oauth_metadata failure (non-OAuth single-user)', () => {
  const stdout = [
    'CHECK control_plane_api_key PASS',
    'CHECK mcp_reachable PASS',
    'CHECK oauth_metadata FAIL HTTP 404 no PRMD metadata',
    'RESULT fail',
  ].join('\n');
  const r = classifyDoctorResult(stdout, 1);
  assert.equal(r.proceed, true);
  assert.ok(r.tolerated.includes('oauth_metadata'));
  assert.deepEqual(r.blocking, []);
});

test('classifyDoctorResult blocks on profile parse failure', () => {
  const stdout = ['CHECK profile_parse FAIL invalid yaml', 'RESULT fail'].join('\n');
  const r = classifyDoctorResult(stdout, 1);
  assert.equal(r.proceed, false);
  assert.ok(r.blocking.some((b) => b.includes('profile_parse')));
});

test('classifyDoctorResult blocks on missing tunnel id / control plane key / unreachable mcp', () => {
  for (const check of ['tunnel_id', 'control_plane_api_key', 'mcp_reachable']) {
    const stdout = [`CHECK ${check} FAIL`, 'RESULT fail'].join('\n');
    const r = classifyDoctorResult(stdout, 1);
    assert.equal(r.proceed, false, `${check} should block`);
  }
});

test('classifyDoctorResult proceeds when doctor passes cleanly', () => {
  const r = classifyDoctorResult('RESULT pass', 0);
  assert.equal(r.proceed, true);
  assert.deepEqual(r.blocking, []);
});

test('classifyDoctorResult blocks when doctor could not run', () => {
  const r = classifyDoctorResult('', 127);
  assert.equal(r.proceed, false);
  assert.ok(r.warning);
  assert.ok(r.blocking.includes('doctor_unavailable'));
});
