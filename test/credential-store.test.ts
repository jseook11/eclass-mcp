import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  CREDENTIAL_BACKEND_ENV,
  ENC_STORE_PATH_ENV,
  SECRET_KEY_ENV,
  SECRET_KEY_FILE_ENV,
  getCredential,
  setCredential,
  encryptSecretFile,
  decryptSecretFile,
  resolveMasterKey,
  resolveBackend,
  describeCredentialEnvironment,
} from '../src/credential-store.js';

test('credential store falls back to a 0600 file store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credentials-'));
  const storePath = path.join(dir, 'secrets.json');
  process.env[CREDENTIAL_BACKEND_ENV] = 'file';
  process.env.ECLASS_SECRET_STORE_PATH = storePath;

  try {
    const backend = await setCredential('service', 'account', 'secret');
    const value = await getCredential('service', 'account');
    const stat = await fs.stat(storePath);

    assert.equal(backend, 'file');
    assert.equal(value, 'secret');
    if (os.platform() !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encryptSecretFile/decryptSecretFile round-trips with AES-256-GCM', () => {
  const key = crypto.randomBytes(32);
  const data = { svc: { acct: 'hunter2' } };
  const enc = encryptSecretFile(key, data);
  assert.equal(enc.v, 1);
  assert.ok(enc.iv && enc.tag && enc.ct);
  assert.notEqual(enc.ct, JSON.stringify(data));
  const back = decryptSecretFile(key, enc);
  assert.deepEqual(back, data);
});

test('decryptSecretFile rejects a wrong key', () => {
  const enc = encryptSecretFile(crypto.randomBytes(32), { a: { b: 'c' } });
  assert.throws(() => decryptSecretFile(crypto.randomBytes(32), enc));
});

test('resolveMasterKey reads base64 32-byte key from env', async () => {
  const key = crypto.randomBytes(32);
  process.env[SECRET_KEY_ENV] = key.toString('base64');
  try {
    const got = await resolveMasterKey();
    assert.ok(got && got.equals(key));
  } finally {
    delete process.env[SECRET_KEY_ENV];
  }
});

test('resolveMasterKey rejects a wrong-length env key', async () => {
  process.env[SECRET_KEY_ENV] = Buffer.from('too-short').toString('base64');
  try {
    await assert.rejects(() => resolveMasterKey(), /32 bytes/);
  } finally {
    delete process.env[SECRET_KEY_ENV];
  }
});

test('resolveMasterKey reads a raw 32-byte key file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-key-'));
  const keyPath = path.join(dir, 'master.key');
  const key = crypto.randomBytes(32);
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  process.env[SECRET_KEY_FILE_ENV] = keyPath;
  try {
    const got = await resolveMasterKey();
    assert.ok(got && got.equals(key));
  } finally {
    delete process.env[SECRET_KEY_FILE_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveMasterKey returns null when no key injected', async () => {
  delete process.env[SECRET_KEY_ENV];
  delete process.env[SECRET_KEY_FILE_ENV];
  assert.equal(await resolveMasterKey(), null);
});

test('encrypted backend stores ciphertext and round-trips via get/set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-enc-'));
  const encPath = path.join(dir, 'secrets.enc');
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = encPath;
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    const backend = await setCredential('eclass-mcp', 'alice', 's3cret');
    assert.equal(backend, 'encrypted');
    const onDisk = await fs.readFile(encPath, 'utf8');
    assert.ok(!onDisk.includes('s3cret'));
    assert.match(onDisk, /"iv"/);
    assert.equal(await getCredential('eclass-mcp', 'alice'), 's3cret');
    const stat = await fs.stat(encPath);
    if (os.platform() !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('explicit encrypted backend without a key throws (no silent fallback)', async () => {
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  delete process.env[SECRET_KEY_ENV];
  delete process.env[SECRET_KEY_FILE_ENV];
  try {
    await assert.rejects(() => resolveBackend(), /master key/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
  }
});

test('describeCredentialEnvironment reports encrypted backend and key presence', async () => {
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    const d = await describeCredentialEnvironment();
    assert.equal(d.backend, 'encrypted');
    assert.equal(d.masterKeyPresent, true);
    assert.equal(typeof d.dbusSession, 'boolean');
    assert.equal(typeof d.keytarLoaded, 'boolean');
  } finally {
    delete process.env[SECRET_KEY_ENV];
  }
});

test('auto backend selects encrypted when a master key is present', async () => {
  delete process.env[CREDENTIAL_BACKEND_ENV];
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    const { backend } = await resolveBackend();
    assert.equal(backend, 'encrypted');
  } finally {
    delete process.env[SECRET_KEY_ENV];
  }
});
