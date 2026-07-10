import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  acquireCanvasTokenLock,
  canvasTokenLockBucketName,
  canvasTokenLockBucketPath,
  withCanvasTokenLock,
  type CanvasTokenLockOptions,
} from '../src/canvas-token-lock.js';

const fastOptions = (rootDir: string): CanvasTokenLockOptions => ({
  rootDir,
  timeoutMs: 2_000,
  pollMs: 5,
  settleMs: 5,
  staleMs: 50,
  hardStaleMs: 1_000,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostHash(): string {
  return crypto.createHash('sha256').update(os.hostname(), 'utf8').digest('hex').slice(0, 16);
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('condition timed out');
    await sleep(10);
  }
}

test('lock paths hash usernames and lock artifacts are private', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX mode assertions');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-'));
  const rootDir = path.join(temp, 'locks');
  const username = 'student@example.edu';
  const lock = await acquireCanvasTokenLock(username, fastOptions(rootDir));
  try {
    const bucketName = canvasTokenLockBucketName(username);
    assert.match(bucketName, /^[a-f0-9]{64}$/);
    assert.equal(bucketName.includes('student'), false);
    assert.equal(lock.bucketPath, canvasTokenLockBucketPath(username, rootDir));
    assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(lock.bucketPath)).mode & 0o777, 0o700);
    const files = await fs.readdir(lock.bucketPath);
    assert.equal(files.length, 1);
    assert.equal((await fs.stat(path.join(lock.bucketPath, files[0]))).mode & 0o777, 0o600);
  } finally {
    await lock.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('two lock clients serialize the same username', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-'));
  const rootDir = path.join(temp, 'locks');
  const options = fastOptions(rootDir);
  const first = await acquireCanvasTokenLock('alice', options);
  let secondEntered = false;
  const second = withCanvasTokenLock('alice', async () => {
    secondEntered = true;
  }, options);

  try {
    const bucket = canvasTokenLockBucketPath('alice', rootDir);
    await waitUntil(async () => (await fs.readdir(bucket)).length === 2);
    assert.equal(secondEntered, false);
    await first.release();
    await second;
    assert.equal(secondEntered, true);
  } finally {
    await first.release();
    await second.catch(() => undefined);
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('a delayed publication cannot introduce an earlier owner after acquisition', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-publish-'));
  const rootDir = path.join(temp, 'locks');
  const username = 'publication-race';
  let markPublished!: () => void;
  const published = new Promise<void>((resolve) => { markPublished = resolve; });
  let resumePublisher!: () => void;
  const resume = new Promise<void>((resolve) => { resumePublisher = resolve; });
  let delayedResolved = false;
  let normalPromise: Promise<Awaited<ReturnType<typeof acquireCanvasTokenLock>>> | undefined;
  let normalLock: Awaited<ReturnType<typeof acquireCanvasTokenLock>> | undefined;

  const delayedPromise = acquireCanvasTokenLock(username, {
    ...fastOptions(rootDir),
    testAfterCandidatePublished: async () => {
      markPublished();
      await resume;
    },
  }).then((lock) => {
    delayedResolved = true;
    return lock;
  });

  try {
    await published;
    normalPromise = acquireCanvasTokenLock(username, fastOptions(rootDir));
    const bucket = canvasTokenLockBucketPath(username, rootDir);
    await waitUntil(async () => (await fs.readdir(bucket)).length === 2);
    await sleep(20);
    assert.equal(delayedResolved, false, 'an uninitialized candidate must block election');

    resumePublisher();
    const normal = await normalPromise;
    normalLock = normal;
    assert.equal(delayedResolved, false, 'post-publication order must make the resumed candidate later');
    await normal.release();

    const delayed = await delayedPromise;
    await delayed.assertOwned();
    await delayed.release();
  } finally {
    resumePublisher();
    if (!normalLock && normalPromise) normalLock = await normalPromise.catch(() => undefined);
    await normalLock?.release();
    const delayed = await delayedPromise.catch(() => null);
    await delayed?.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('a separate Node process cannot enter until the owner releases', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-child-'));
  const rootDir = path.join(temp, 'locks');
  const options = fastOptions(rootDir);
  const username = 'shared-user';
  const first = await acquireCanvasTokenLock(username, options);
  const moduleUrl = pathToFileURL(path.resolve('src/canvas-token-lock.ts')).href;
  const script = [
    `import { acquireCanvasTokenLock } from ${JSON.stringify(moduleUrl)};`,
    `const lock = await acquireCanvasTokenLock(${JSON.stringify(username)}, ${JSON.stringify(options)});`,
    `process.stdout.write('acquired\\n');`,
    `await lock.release();`,
  ].join('\n');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    const bucket = canvasTokenLockBucketPath(username, rootDir);
    await waitUntil(async () => (await fs.readdir(bucket)).length === 2);
    assert.equal(stdout, '');
    await first.release();
    const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, stderr);
    assert.equal(stdout, 'acquired\n');
  } finally {
    await first.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('stale dead-process candidates are recovered without deleting live candidates', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-stale-'));
  const rootDir = path.join(temp, 'locks');
  const username = 'stale-user';
  const bucket = canvasTokenLockBucketPath(username, rootDir);
  await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
  const nonce = 'a'.repeat(32);
  const stalePath = path.join(bucket, `${hostHash()}-99999999-${nonce}.lock`);
  await fs.writeFile(stalePath, JSON.stringify({
    version: 1,
    pid: 99_999_999,
    hostname: os.hostname(),
    nonce,
    created_at_ms: Date.now() - 10_000,
    monotonic_ns: '1',
  }), { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(stalePath, old, old);

  const lock = await acquireCanvasTokenLock(username, {
    ...fastOptions(rootDir),
    staleMs: 10,
    hardStaleMs: 100,
  });
  try {
    await assert.rejects(() => fs.stat(stalePath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
    await lock.assertOwned();
  } finally {
    await lock.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('an old candidate owned by a live PID is never stolen', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-live-'));
  const rootDir = path.join(temp, 'locks');
  const username = 'live-user';
  const bucket = canvasTokenLockBucketPath(username, rootDir);
  await fs.mkdir(bucket, { recursive: true, mode: 0o700 });
  const nonce = 'b'.repeat(32);
  const ownerPath = path.join(bucket, `${hostHash()}-${process.pid}-${nonce}.lock`);
  await fs.writeFile(ownerPath, JSON.stringify({
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    nonce,
    created_at_ms: Date.now() - 10_000,
    monotonic_ns: '1',
  }), { mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(ownerPath, old, old);

  try {
    await assert.rejects(
      () => acquireCanvasTokenLock(username, {
        ...fastOptions(rootDir),
        timeoutMs: 50,
        staleMs: 5,
        hardStaleMs: 10,
      }),
      /Timed out waiting for Canvas token lock/,
    );
    assert.equal((await fs.stat(ownerPath)).isFile(), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('waiting for a live owner fails with a bounded timeout', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-timeout-'));
  const rootDir = path.join(temp, 'locks');
  const first = await acquireCanvasTokenLock('alice', fastOptions(rootDir));
  try {
    await assert.rejects(
      () => acquireCanvasTokenLock('alice', {
        ...fastOptions(rootDir),
        timeoutMs: 60,
      }),
      /Timed out waiting for Canvas token lock/,
    );
    await first.assertOwned();
  } finally {
    await first.release();
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('withCanvasTokenLock releases ownership when the callback throws', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-token-lock-error-'));
  const rootDir = path.join(temp, 'locks');
  const options = fastOptions(rootDir);
  try {
    await assert.rejects(
      () => withCanvasTokenLock('alice', async () => {
        throw new Error('callback failed');
      }, options),
      /callback failed/,
    );

    const lock = await acquireCanvasTokenLock('alice', options);
    await lock.assertOwned();
    await lock.release();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
