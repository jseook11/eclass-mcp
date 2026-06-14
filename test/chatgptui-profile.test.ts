import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { renderTunnelProfile, ensureTunnelProfile } from '../src/chatgptui/profile.js';

const OPTS = { tunnelId: 'tunnel_xyz', port: 8787 };

test('renderTunnelProfile emits http MCP target with X-Eclass-Auth env refs', () => {
  const yaml = renderTunnelProfile(OPTS);
  const doc = parse(yaml);
  assert.equal(doc.config_version, 1);
  assert.equal(doc.control_plane.tunnel_id, 'tunnel_xyz');
  assert.equal(doc.control_plane.api_key, 'env:CONTROL_PLANE_API_KEY');
  assert.equal(doc.mcp.server_urls[0].url, 'http://127.0.0.1:8787/mcp');
  assert.equal(doc.mcp.extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
  assert.equal(doc.mcp.discovery_extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
});

test('renderTunnelProfile never embeds a literal api key', () => {
  const yaml = renderTunnelProfile({ tunnelId: 'tunnel_xyz', port: 9999 });
  assert.ok(!/sk-/.test(yaml));
  assert.match(yaml, /api_key:\s*env:CONTROL_PLANE_API_KEY/);
});

test('ensureTunnelProfile creates a 0600 file when missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-prof-'));
  const file = path.join(dir, 'sub', 'eclass-mcp.yaml');
  try {
    const result = await ensureTunnelProfile(file, OPTS);
    assert.equal(result.created, true);
    const stat = await fs.stat(file);
    if (os.platform() !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    const doc = parse(await fs.readFile(file, 'utf8'));
    assert.equal(doc.mcp.extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ensureTunnelProfile migrates Authorization to X-Eclass-Auth for managed profile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-prof2-'));
  const file = path.join(dir, 'eclass-mcp.yaml');
  const existing = [
    'config_version: 1',
    'control_plane:',
    '  tunnel_id: tunnel_existing',
    '  api_key: env:CONTROL_PLANE_API_KEY',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    '      url: http://127.0.0.1:8787/mcp',
    '  extra_headers:',
    '    Authorization: env:ECLASS_REMOTE_AUTH_TOKEN',
    '  discovery_extra_headers:',
    '    Authorization: env:ECLASS_REMOTE_AUTH_TOKEN',
    '',
  ].join('\n');
  await fs.writeFile(file, existing, { mode: 0o600 });
  try {
    const result = await ensureTunnelProfile(file, OPTS, { managedProfile: true });
    assert.equal(result.created, false);
    const doc = parse(await fs.readFile(file, 'utf8'));
    assert.equal(doc.mcp.extra_headers.Authorization, undefined);
    assert.equal(doc.mcp.discovery_extra_headers.Authorization, undefined);
    assert.equal(doc.mcp.extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
    assert.equal(doc.mcp.discovery_extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
    assert.equal(doc.control_plane.tunnel_id, 'tunnel_existing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ensureTunnelProfile refuses Authorization migration for custom profile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-prof-custom-'));
  const file = path.join(dir, 'custom.yaml');
  const existing = [
    'config_version: 1',
    'control_plane:',
    '  tunnel_id: tunnel_existing',
    '  api_key: env:CONTROL_PLANE_API_KEY',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    '      url: http://127.0.0.1:8787/mcp',
    '  extra_headers:',
    '    Authorization: env:ECLASS_REMOTE_AUTH_TOKEN',
    '',
  ].join('\n');
  await fs.writeFile(file, existing, { mode: 0o600 });
  try {
    await assert.rejects(
      () => ensureTunnelProfile(file, OPTS, { managedProfile: false }),
      /Authorization.*X-Eclass-Auth/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ensureTunnelProfile patches in X-Eclass-Auth when no auth header exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-prof3-'));
  const file = path.join(dir, 'eclass-mcp.yaml');
  const existing = [
    'config_version: 1',
    'control_plane:',
    '  tunnel_id: tunnel_existing',
    '  api_key: env:CONTROL_PLANE_API_KEY',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    '      url: http://127.0.0.1:8787/mcp',
    '',
  ].join('\n');
  await fs.writeFile(file, existing, { mode: 0o600 });
  try {
    await ensureTunnelProfile(file, OPTS);
    const doc = parse(await fs.readFile(file, 'utf8'));
    assert.equal(doc.mcp.extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
    assert.equal(doc.mcp.discovery_extra_headers['X-Eclass-Auth'], 'env:ECLASS_REMOTE_AUTH_TOKEN');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
