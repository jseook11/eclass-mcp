import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYCHAIN_SERVICE,
  getEclassPassword,
  getSecretEnvWarning,
} from '../src/secrets.js';

test('getEclassPassword ignores env password without override flag', async () => {
  await assert.rejects(
    () => getEclassPassword('test-user', 'env-password', async () => null),
    /Password not found/,
  );
});

test('getEclassPassword uses env password when override flag is enabled', async () => {
  process.env.ALLOW_PLAINTEXT_ENV_SECRETS = '1';
  const password = await getEclassPassword('test-user', 'env-password', async () => {
    throw new Error('keychain should not be queried');
  });
  delete process.env.ALLOW_PLAINTEXT_ENV_SECRETS;

  assert.equal(password, 'env-password');
});

test('getEclassPassword uses keyed username account', async () => {
  const password = await getEclassPassword('test-user', undefined, async (service, account) => {
    assert.equal(service, KEYCHAIN_SERVICE);
    assert.equal(account, 'test-user');
    return 'pw';
  });
  assert.equal(password, 'pw');
});

test('getEclassPassword error names the active backend and next action', async () => {
  const noop = async () => null;
  await assert.rejects(
    () => getEclassPassword('alice', undefined, noop, undefined),
    (err: Error) => /backend=/.test(err.message) && /setup/.test(err.message),
  );
});

test('getSecretEnvWarning distinguishes ignored and active env secrets', () => {
  delete process.env.ALLOW_PLAINTEXT_ENV_SECRETS;
  assert.match(
    getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호', 'plaintext') ?? '',
    /무시됩니다/,
  );

  process.env.ALLOW_PLAINTEXT_ENV_SECRETS = '1';
  assert.match(
    getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호', 'plaintext') ?? '',
    /env에서 로드됩니다/,
  );
  delete process.env.ALLOW_PLAINTEXT_ENV_SECRETS;
});
