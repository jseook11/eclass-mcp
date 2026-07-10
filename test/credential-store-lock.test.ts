import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CREDENTIAL_BACKEND_ENV,
  ENC_STORE_PATH_ENV,
  SECRET_KEY_ENV,
  decryptSecretFile,
  encryptSecretFile,
  type EncFile,
} from '../src/credential-store.js';
import {
  acquireCredentialStoreLock,
  withCredentialStoreLock,
} from '../src/credential-store-lock.js';

type RunningChild = {
  child: ChildProcessWithoutNullStreams;
  close: Promise<[number | null, NodeJS.Signals | null]>;
  stdout(): string;
  stderr(): string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('condition timed out');
    await sleep(10);
  }
}

function spawnScript(script: string, env: NodeJS.ProcessEnv = process.env): RunningChild {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const close = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, close, stdout: () => stdout, stderr: () => stderr };
}

async function assertChildSucceeded(run: RunningChild): Promise<void> {
  const [code] = await run.close;
  assert.equal(code, 0, run.stderr());
}

async function readyCandidateCount(bucketPath: string): Promise<number> {
  return (await fs.readdir(bucketPath)).filter((name) => name.endsWith('.lock')).length;
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function readEncryptedStore(storePath: string, key: Buffer): Promise<Record<string, Record<string, string>>> {
  const enc = JSON.parse(await fs.readFile(storePath, 'utf8')) as EncFile;
  return decryptSecretFile(key, enc);
}

function credentialChildEnv(storePath: string, key: Buffer, legacyPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [CREDENTIAL_BACKEND_ENV]: 'encrypted',
    [ENC_STORE_PATH_ENV]: storePath,
    [SECRET_KEY_ENV]: key.toString('base64'),
    ECLASS_SECRET_KEY_FILE: undefined,
    ECLASS_SECRET_STORE_PATH: legacyPath,
  };
}

test('credential-store lock is private, path-anonymous, and serializes same-process callers', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-lock-'));
  const storePath = path.join(temp, 'sensitive-store-name.enc');
  const first = await acquireCredentialStoreLock(storePath, {
    timeoutMs: 2_000,
    pollMs: 5,
    staleMs: 100,
  });
  let secondEntered = false;
  const second = withCredentialStoreLock(storePath, async () => {
    secondEntered = true;
  }, { timeoutMs: 2_000, pollMs: 5, staleMs: 100 });

  try {
    await waitUntil(async () => await readyCandidateCount(first.bucketPath) === 2);
    assert.equal(secondEntered, false);
    assert.equal(first.bucketPath.includes('sensitive-store-name'), false);
    const candidateNames = await fs.readdir(first.bucketPath);
    assert.equal(candidateNames.some((name) => name.includes('account')), false);
    if (os.platform() !== 'win32') {
      assert.equal((await fs.stat(first.bucketPath)).mode & 0o777, 0o700);
      for (const candidateName of candidateNames) {
        assert.equal((await fs.stat(path.join(first.bucketPath, candidateName))).mode & 0o777, 0o600);
      }
    }
    await first.release();
    await second;
    assert.equal(secondEntered, true);
    assert.deepEqual(await fs.readdir(first.bucketPath), []);
  } finally {
    await first.release();
    await second.catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('waiting on a live credential-store owner has a bounded timeout', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-lock-timeout-'));
  const storePath = path.join(temp, 'secrets.enc');
  const first = await acquireCredentialStoreLock(storePath, {
    timeoutMs: 1_000,
    pollMs: 5,
    staleMs: 20,
  });
  try {
    await assert.rejects(
      () => acquireCredentialStoreLock(storePath, {
        timeoutMs: 60,
        pollMs: 5,
        staleMs: 20,
      }),
      /Timed out waiting for encrypted credential-store lock/,
    );
    await first.assertOwned();
  } finally {
    await first.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('a dead child owner is recovered, while a live owner is never broken as stale', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-lock-stale-'));
  const storePath = path.join(temp, 'secrets.enc');
  const lockModuleUrl = pathToFileURL(path.resolve('src/credential-store-lock.ts')).href;
  const child = spawnScript([
    `import { acquireCredentialStoreLock } from ${JSON.stringify(lockModuleUrl)};`,
    `const lock = await acquireCredentialStoreLock(${JSON.stringify(storePath)}, { timeoutMs: 1000, pollMs: 5, staleMs: 30 });`,
    `process.stdout.write('acquired\\n');`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'));
  t.after(() => child.child.kill('SIGKILL'));

  try {
    await waitUntil(async () => child.stdout() === 'acquired\n');
    child.child.kill('SIGKILL');
    await child.close;
    await sleep(60);

    const recovered = await acquireCredentialStoreLock(storePath, {
      timeoutMs: 1_000,
      pollMs: 5,
      staleMs: 30,
    });
    try {
      await recovered.assertOwned();
      assert.equal(await readyCandidateCount(recovered.bucketPath), 1);
    } finally {
      await recovered.release();
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('two child-process set transactions preserve unrelated encrypted accounts', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-rmw-set-'));
  const storePath = path.join(temp, 'secrets.enc');
  const legacyPath = path.join(temp, 'secrets.json');
  const key = crypto.randomBytes(32);
  const env = credentialChildEnv(storePath, key, legacyPath);
  const moduleUrl = pathToFileURL(path.resolve('src/credential-store.ts')).href;
  const owner = await acquireCredentialStoreLock(storePath, {
    timeoutMs: 2_000,
    pollMs: 5,
    staleMs: 100,
  });
  const alice = spawnScript([
    `import { setCredential } from ${JSON.stringify(moduleUrl)};`,
    `await setCredential('svc', 'alice', 'alice-secret');`,
    `process.stdout.write('done\\n');`,
  ].join('\n'), env);
  t.after(() => alice.child.kill('SIGKILL'));
  let bob: RunningChild | undefined;

  try {
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 2);
    assert.equal(alice.stdout(), '');
    bob = spawnScript([
      `import { setCredential } from ${JSON.stringify(moduleUrl)};`,
      `await setCredential('svc', 'bob', 'bob-secret');`,
      `process.stdout.write('done\\n');`,
    ].join('\n'), env);
    t.after(() => bob?.child.kill('SIGKILL'));
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 3);
    assert.equal(bob.stdout(), '');

    await owner.release();
    await Promise.all([assertChildSucceeded(alice), assertChildSucceeded(bob)]);
    const stored = await readEncryptedStore(storePath, key);
    assert.equal(stored[encoded('svc')]?.[encoded('alice')], 'alice-secret');
    assert.equal(stored[encoded('svc')]?.[encoded('bob')], 'bob-secret');
  } finally {
    await owner.release();
    alice.child.kill('SIGKILL');
    bob?.child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('child-process delete then set transactions serialize in queue order', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-rmw-delete-set-'));
  const storePath = path.join(temp, 'secrets.enc');
  const legacyPath = path.join(temp, 'secrets.json');
  const key = crypto.randomBytes(32);
  await fs.writeFile(storePath, `${JSON.stringify(encryptSecretFile(key, {
    [encoded('svc')]: { [encoded('target')]: 'initial' },
  }))}\n`, { mode: 0o600 });
  const env = credentialChildEnv(storePath, key, legacyPath);
  const moduleUrl = pathToFileURL(path.resolve('src/credential-store.ts')).href;
  const owner = await acquireCredentialStoreLock(storePath, {
    timeoutMs: 2_000,
    pollMs: 5,
    staleMs: 100,
  });
  const deleting = spawnScript([
    `import { deleteCredential } from ${JSON.stringify(moduleUrl)};`,
    `await deleteCredential('svc', 'target');`,
    `process.stdout.write('done\\n');`,
  ].join('\n'), env);
  t.after(() => deleting.child.kill('SIGKILL'));
  let setting: RunningChild | undefined;

  try {
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 2);
    setting = spawnScript([
      `import { setCredential } from ${JSON.stringify(moduleUrl)};`,
      `await setCredential('svc', 'target', 'replacement');`,
      `process.stdout.write('done\\n');`,
    ].join('\n'), env);
    t.after(() => setting?.child.kill('SIGKILL'));
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 3);
    assert.equal(deleting.stdout(), '');
    assert.equal(setting.stdout(), '');
    assert.equal(
      (await readEncryptedStore(storePath, key))[encoded('svc')]?.[encoded('target')],
      'initial',
    );

    await owner.release();
    await Promise.all([assertChildSucceeded(deleting), assertChildSucceeded(setting)]);
    const stored = await readEncryptedStore(storePath, key);
    assert.equal(stored[encoded('svc')]?.[encoded('target')], 'replacement');
  } finally {
    await owner.release();
    deleting.child.kill('SIGKILL');
    setting?.child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('concurrent secure writes serialize matching plaintext cleanup without restoring entries', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-credential-legacy-rmw-'));
  const legacyPath = path.join(temp, 'secrets.json');
  const aliceEncPath = path.join(temp, 'alice.enc');
  const bobEncPath = path.join(temp, 'bob.enc');
  const aliceKey = crypto.randomBytes(32);
  const bobKey = crypto.randomBytes(32);
  const serviceKey = encoded('svc');
  await fs.writeFile(legacyPath, `${JSON.stringify({
    [serviceKey]: {
      [encoded('alice')]: 'stale-alice',
      [encoded('bob')]: 'stale-bob',
      [encoded('carol')]: 'keep-carol',
    },
  })}\n`, { mode: 0o600 });

  const moduleUrl = pathToFileURL(path.resolve('src/credential-store.ts')).href;
  const owner = await acquireCredentialStoreLock(legacyPath, {
    timeoutMs: 2_000,
    pollMs: 5,
    staleMs: 100,
  });
  const alice = spawnScript([
    `import { setCredential } from ${JSON.stringify(moduleUrl)};`,
    `await setCredential('svc', 'alice', 'secure-alice');`,
    `process.stdout.write('done\\n');`,
  ].join('\n'), credentialChildEnv(aliceEncPath, aliceKey, legacyPath));
  t.after(() => alice.child.kill('SIGKILL'));
  let bob: RunningChild | undefined;

  try {
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 2);
    bob = spawnScript([
      `import { setCredential } from ${JSON.stringify(moduleUrl)};`,
      `await setCredential('svc', 'bob', 'secure-bob');`,
      `process.stdout.write('done\\n');`,
    ].join('\n'), credentialChildEnv(bobEncPath, bobKey, legacyPath));
    t.after(() => bob?.child.kill('SIGKILL'));
    await waitUntil(async () => await readyCandidateCount(owner.bucketPath) === 3);
    assert.equal(alice.stdout(), '');
    assert.equal(bob.stdout(), '');

    await owner.release();
    await Promise.all([assertChildSucceeded(alice), assertChildSucceeded(bob)]);
    const legacy = JSON.parse(await fs.readFile(legacyPath, 'utf8')) as Record<string, Record<string, string>>;
    assert.equal(legacy[serviceKey]?.[encoded('alice')], undefined);
    assert.equal(legacy[serviceKey]?.[encoded('bob')], undefined);
    assert.equal(legacy[serviceKey]?.[encoded('carol')], 'keep-carol');
  } finally {
    await owner.release();
    alice.child.kill('SIGKILL');
    bob?.child.kill('SIGKILL');
    await fs.rm(temp, { recursive: true, force: true });
  }
});
