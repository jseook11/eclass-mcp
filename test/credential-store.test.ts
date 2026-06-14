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
  getCredential,
  setCredential,
  encryptSecretFile,
  decryptSecretFile,
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
