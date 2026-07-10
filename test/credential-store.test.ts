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
  readKeytarCredential,
  resolveMasterKey,
  resolveBackend,
  describeCredentialEnvironment,
} from '../src/credential-store.js';
import { credentialBackendCheck } from '../src/doctor.js';

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

test('explicit plaintext file backend is legacy read-only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credentials-'));
  const storePath = path.join(dir, 'secrets.json');
  process.env[CREDENTIAL_BACKEND_ENV] = 'file';
  process.env.ECLASS_SECRET_STORE_PATH = storePath;

  try {
    await fs.writeFile(storePath, JSON.stringify({
      [encoded('service')]: { [encoded('account')]: 'secret' },
    }), { mode: 0o600 });
    const value = await getCredential('service', 'account');
    assert.equal(value, 'secret');
    const before = await fs.readFile(storePath, 'utf8');
    await assert.rejects(() => setCredential('service', 'account', 'new'), /legacy read-only/);
    assert.equal(await fs.readFile(storePath, 'utf8'), before);
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

test('readKeytarCredential preserves a legitimate miss and propagates backend failures', async () => {
  assert.equal(await readKeytarCredential({
    getPassword: async () => null,
  }, 'svc', 'missing'), null);

  await assert.rejects(
    () => readKeytarCredential({
      getPassword: async () => {
        throw new Error('keychain temporarily unavailable');
      },
    }, 'svc', 'account'),
    /keychain temporarily unavailable/,
  );
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

test('resolveMasterKey rejects unsafe key-file permissions and symlinks', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission/symlink test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-key-unsafe-'));
  const keyPath = path.join(dir, 'master.key');
  const linkPath = path.join(dir, 'master-link.key');
  await fs.writeFile(keyPath, crypto.randomBytes(32), { mode: 0o644 });
  process.env[SECRET_KEY_FILE_ENV] = keyPath;
  try {
    await assert.rejects(() => resolveMasterKey(), /unsafe permissions/);
    await fs.chmod(keyPath, 0o600);
    await fs.symlink(keyPath, linkPath);
    process.env[SECRET_KEY_FILE_ENV] = linkPath;
    await assert.rejects(() => resolveMasterKey(), /symbolic link/);
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
    if (os.platform() !== 'win32') await fs.chmod(dir, 0o755);
    const backend = await setCredential('eclass-mcp', 'alice', 's3cret');
    assert.equal(backend, 'encrypted');
    const onDisk = await fs.readFile(encPath, 'utf8');
    assert.ok(!onDisk.includes('s3cret'));
    assert.match(onDisk, /"iv"/);
    assert.equal(await getCredential('eclass-mcp', 'alice'), 's3cret');
    const stat = await fs.stat(encPath);
    if (os.platform() !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    }
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encrypted credential store rejects unsafe permissions', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-enc-unsafe-'));
  const encPath = path.join(dir, 'secrets.enc');
  const key = crypto.randomBytes(32);
  await fs.writeFile(encPath, JSON.stringify(encryptSecretFile(key, {
    [encoded('svc')]: { [encoded('acct')]: 'secret' },
  })), { mode: 0o644 });
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = encPath;
  process.env[SECRET_KEY_ENV] = key.toString('base64');
  try {
    await assert.rejects(() => getCredential('svc', 'acct'), /unsafe permissions/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encrypted backend rejects identical encrypted and legacy store paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-enc-same-path-'));
  const storePath = path.join(dir, 'secrets.enc');
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = storePath;
  process.env.ECLASS_SECRET_STORE_PATH = storePath;
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    await assert.rejects(
      () => setCredential('svc', 'acct', 'secret'),
      /must refer to different files/,
    );
    await assert.rejects(() => fs.stat(storePath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encrypted writes purge only the matching plaintext legacy duplicate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-purge-legacy-'));
  const encPath = path.join(dir, 'secrets.enc');
  const legacyPath = path.join(dir, 'secrets.json');
  const targetService = encoded('eclass-mcp');
  const targetAccount = encoded('alice');
  const otherAccount = encoded('bob');
  const otherService = encoded('other-service');
  await fs.writeFile(legacyPath, JSON.stringify({
    [targetService]: {
      [targetAccount]: 'stale-alice',
      [otherAccount]: 'keep-bob',
    },
    [otherService]: { [encoded('service-account')]: 'keep-other' },
  }), { mode: 0o600 });
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = encPath;
  process.env.ECLASS_SECRET_STORE_PATH = legacyPath;
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    await setCredential('eclass-mcp', 'alice', 'secure-alice');
    assert.equal(await getCredential('eclass-mcp', 'alice'), 'secure-alice');
    const legacy = JSON.parse(await fs.readFile(legacyPath, 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(legacy[targetService]?.[targetAccount], undefined);
    assert.equal(legacy[targetService]?.[otherAccount], 'keep-bob');
    assert.equal(legacy[otherService]?.[encoded('service-account')], 'keep-other');
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encrypted writes remove an empty plaintext legacy file after purge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-purge-empty-'));
  const legacyPath = path.join(dir, 'secrets.json');
  await fs.writeFile(legacyPath, JSON.stringify({
    [encoded('svc')]: { [encoded('acct')]: 'stale' },
  }), { mode: 0o600 });
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = path.join(dir, 'secrets.enc');
  process.env.ECLASS_SECRET_STORE_PATH = legacyPath;
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    await setCredential('svc', 'acct', 'secure');
    await assert.rejects(() => fs.stat(legacyPath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential stores reject unsafe permissions and symlinks on read', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission/symlink test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-store-unsafe-'));
  const legacyPath = path.join(dir, 'secrets.json');
  const linkPath = path.join(dir, 'secrets-link.json');
  await fs.writeFile(legacyPath, '{}', { mode: 0o644 });
  process.env[CREDENTIAL_BACKEND_ENV] = 'file';
  process.env.ECLASS_SECRET_STORE_PATH = legacyPath;
  try {
    await assert.rejects(() => getCredential('svc', 'acct'), /unsafe permissions/);
    await fs.chmod(legacyPath, 0o600);
    await fs.symlink(legacyPath, linkPath);
    process.env.ECLASS_SECRET_STORE_PATH = linkPath;
    await assert.rejects(() => getCredential('svc', 'acct'), /symbolic link/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
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

test('auto backend never selects the plaintext legacy file backend', async () => {
  delete process.env[CREDENTIAL_BACKEND_ENV];
  delete process.env[SECRET_KEY_ENV];
  delete process.env[SECRET_KEY_FILE_ENV];
  try {
    try {
      const { backend } = await resolveBackend();
      assert.notEqual(backend, 'file');
    } catch (err) {
      assert.match(err instanceof Error ? err.message : String(err), /No secure credential backend/);
    }
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
  }
});

test('setCredential refuses the plaintext file backend regardless of fallback option', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-nofile-'));
  process.env[CREDENTIAL_BACKEND_ENV] = 'file';
  process.env.ECLASS_SECRET_STORE_PATH = path.join(dir, 'secrets.json');
  try {
    await assert.rejects(
      () => setCredential('svc', 'acct', 'pw', { allowFileFallback: false }),
      /legacy read-only/,
    );
    // 거부됐으므로 파일이 생성되지 않아야 한다(평문 미기록).
    await assert.rejects(() => fs.stat(path.join(dir, 'secrets.json')));
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env.ECLASS_SECRET_STORE_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credentialBackendCheck reports ok when credential is found', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-doc-'));
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = path.join(dir, 'secrets.enc');
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    await setCredential('eclass-mcp', 'alice', 'pw');
    const res = await credentialBackendCheck('alice');
    assert.equal(res.ok, true);
    assert.match(res.detail, /encrypted/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credentialBackendCheck reports not-ok when credential missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-doc2-'));
  process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  process.env[ENC_STORE_PATH_ENV] = path.join(dir, 'secrets.enc');
  process.env[SECRET_KEY_ENV] = crypto.randomBytes(32).toString('base64');
  try {
    const res = await credentialBackendCheck('nobody');
    assert.equal(res.ok, false);
    assert.match(res.detail, /not found|없음/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
    delete process.env[ENC_STORE_PATH_ENV];
    delete process.env[SECRET_KEY_ENV];
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credentialBackendCheck reports an unavailable backend without throwing', async () => {
  process.env[CREDENTIAL_BACKEND_ENV] = 'invalid-backend';
  try {
    const res = await credentialBackendCheck('nobody');
    assert.equal(res.ok, false);
    assert.match(res.detail, /backend=unavailable|credential lookup failed/);
  } finally {
    delete process.env[CREDENTIAL_BACKEND_ENV];
  }
});
