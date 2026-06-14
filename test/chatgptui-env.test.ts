import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateChatgptuiEnv } from '../src/chatgptui/env.js';

function baseEnv(): Record<string, string> {
  return {
    ECLASS_CREDENTIAL_BACKEND: 'encrypted',
    ECLASS_SECRET_KEY: 'a'.repeat(44),
    CONTROL_PLANE_API_KEY: 'sk-test',
    CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
    ECLASS_USERNAME: 'student1',
  };
}

test('validateChatgptuiEnv passes with all required env and defaults', () => {
  const r = validateChatgptuiEnv(baseEnv());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.port, 8787);
  assert.equal(r.tunnelId, 'tunnel_abc');
  assert.ok(r.token.length >= 32);
  assert.equal(r.profilePath, path.join(os.homedir(), '.config', 'tunnel-client', 'eclass-mcp.yaml'));
});

test('validateChatgptuiEnv honors XDG_CONFIG_HOME for profile path', () => {
  const env = { ...baseEnv(), XDG_CONFIG_HOME: '/tmp/xdg' };
  const r = validateChatgptuiEnv(env);
  assert.equal(r.profilePath, '/tmp/xdg/tunnel-client/eclass-mcp.yaml');
});

test('validateChatgptuiEnv reuses provided ECLASS_REMOTE_AUTH_TOKEN', () => {
  const env = { ...baseEnv(), ECLASS_REMOTE_AUTH_TOKEN: 'preset-token' };
  const r = validateChatgptuiEnv(env);
  assert.equal(r.token, 'preset-token');
});

test('validateChatgptuiEnv treats an empty ECLASS_REMOTE_AUTH_TOKEN as absent', () => {
  const env = { ...baseEnv(), ECLASS_REMOTE_AUTH_TOKEN: '' };
  const r = validateChatgptuiEnv(env);
  assert.ok(r.token.length >= 32);
  assert.notEqual(r.token, '');
});

test('validateChatgptuiEnv requires encrypted credential backend', () => {
  const env = { ...baseEnv() };
  delete env.ECLASS_CREDENTIAL_BACKEND;
  const r = validateChatgptuiEnv(env);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ECLASS_CREDENTIAL_BACKEND')));
});

test('validateChatgptuiEnv requires a master key with encrypted backend', () => {
  const env = { ...baseEnv() };
  delete env.ECLASS_SECRET_KEY;
  const r = validateChatgptuiEnv(env);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ECLASS_SECRET_KEY')));
});

test('validateChatgptuiEnv accepts OPENAI_API_KEY as control plane fallback', () => {
  const env = { ...baseEnv() };
  delete env.CONTROL_PLANE_API_KEY;
  env.OPENAI_API_KEY = 'sk-fallback';
  const r = validateChatgptuiEnv(env);
  assert.equal(r.ok, true);
});

test('validateChatgptuiEnv collects multiple missing-env errors and never leaks secret values', () => {
  const r = validateChatgptuiEnv({ ECLASS_SECRET_KEY: 'supersecret' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3);
  assert.ok(!r.errors.join('\n').includes('supersecret'));
});
