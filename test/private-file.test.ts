import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertPrivateFile,
  createPrivateFileExclusive,
  makeManagedFilePrivate,
  writePrivateTextFileAtomic,
} from '../src/private-file.js';

test('managed private files are repaired to 0600', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-managed-'));
  const file = path.join(dir, '.env.chatgptui');
  try {
    await fs.writeFile(file, 'CONTROL_PLANE_API_KEY=test\n', { mode: 0o644 });
    await makeManagedFilePrivate(file, 'managed env');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('custom private file validation rejects broad permissions and symlinks', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission/symlink test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-custom-'));
  const target = path.join(dir, 'custom.env');
  const link = path.join(dir, 'custom-link.env');
  try {
    await fs.writeFile(target, 'SECRET=value\n', { mode: 0o644 });
    await assert.rejects(() => assertPrivateFile(target, 'custom env'), /unsafe permissions/);
    await fs.chmod(target, 0o600);
    await fs.symlink(target, link);
    await assert.rejects(() => assertPrivateFile(link, 'custom env'), /symbolic link/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('private file validation rejects a file owned by another uid', async (t) => {
  if (os.platform() === 'win32' || typeof process.getuid !== 'function') {
    return t.skip('POSIX ownership test');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-owner-'));
  const file = path.join(dir, 'secret.env');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  try {
    await fs.writeFile(file, 'SECRET=value\n', { mode: 0o600 });
    const actualUid = (await fs.stat(file)).uid;
    Object.defineProperty(process, 'getuid', {
      ...descriptor,
      value: () => actualUid + 1,
    });
    await assert.rejects(
      () => assertPrivateFile(file, 'secret input'),
      /owned by the current user/,
    );
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('exclusive master-key creation writes raw 32 bytes under 0700 parent', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-key-'));
  const parent = path.join(root, 'keys');
  const file = path.join(parent, 'master.key');
  const key = Buffer.alloc(32, 7);
  try {
    await fs.mkdir(parent, { mode: 0o755 });
    await fs.chmod(parent, 0o755);
    await createPrivateFileExclusive(file, key);
    assert.deepEqual(await fs.readFile(file), key);
    assert.equal((await fs.stat(parent)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await assert.rejects(() => createPrivateFileExclusive(file, Buffer.alloc(32, 9)), /EEXIST/);
    assert.deepEqual(await fs.readFile(file), key);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exclusive master-key creation rejects material that is not exactly 32 bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-key-size-'));
  const file = path.join(root, 'keys', 'master.key');
  try {
    await assert.rejects(
      () => createPrivateFileExclusive(file, Buffer.alloc(31)),
      /exactly 32 bytes/,
    );
    await assert.rejects(
      () => createPrivateFileExclusive(file, Buffer.alloc(33)),
      /exactly 32 bytes/,
    );
    await assert.rejects(() => fs.lstat(file), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exclusive master-key creation rejects a shared parent', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-shared-parent-'));
  const parent = path.join(root, 'keys');
  try {
    await fs.mkdir(parent, { mode: 0o777 });
    await fs.chmod(parent, 0o777);
    await assert.rejects(
      () => createPrivateFileExclusive(path.join(parent, 'master.key'), Buffer.alloc(32, 3)),
      /must not be shared/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('exclusive master-key creation rejects a filesystem-root parent', async () => {
  const root = path.parse(process.cwd()).root;
  await assert.rejects(
    () => createPrivateFileExclusive(path.join(root, 'eclass-test-master.key'), Buffer.alloc(32, 3)),
    /must not be a filesystem root/,
  );
});

test('exclusive master-key creation rejects a symlinked parent', async (t) => {
  if (os.platform() === 'win32') return t.skip('symlink test');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-parent-link-'));
  const realParent = path.join(root, 'real');
  const linkedParent = path.join(root, 'linked');
  try {
    await fs.mkdir(realParent, { mode: 0o700 });
    await fs.symlink(realParent, linkedParent);
    await assert.rejects(
      () => createPrivateFileExclusive(path.join(linkedParent, 'master.key'), Buffer.alloc(32, 3)),
      /symbolic link/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('atomic private text writer replaces through a 0600 same-directory file', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-private-atomic-'));
  const file = path.join(dir, 'config.json');
  try {
    await writePrivateTextFileAtomic(file, 'first\n', { label: 'config' });
    await writePrivateTextFileAtomic(file, 'second\n', { label: 'config' });
    assert.equal(await fs.readFile(file, 'utf8'), 'second\n');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
