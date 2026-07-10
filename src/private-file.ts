import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT');
}

function modeString(mode: number): string {
  return `0o${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/**
 * Secret-bearing input files must be regular files and must not grant any
 * permissions to group/other users. POSIX permission checks are skipped on
 * Windows, where Node does not expose the same permission model.
 */
export async function assertPrivateFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if (os.platform() !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current user: ${filePath}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `${label} has unsafe permissions ${modeString(stat.mode)}; ` +
        `remove all group/other permissions before use: ${filePath}`,
      );
    }
  }
}

export async function assertPrivateFileIfExists(filePath: string, label: string): Promise<boolean> {
  try {
    await assertPrivateFile(filePath, label);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** The repository-managed env file may be repaired in place. */
export async function makeManagedFilePrivate(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if (os.platform() !== 'win32') await fs.chmod(filePath, 0o600);
  await assertPrivateFile(filePath, label);
}

/**
 * Creates a new raw secret file without ever overwriting an existing path.
 * The immediate parent must be an owned, non-shared real directory. Existing
 * safe parents are tightened to 0700; missing parents are created as 0700.
 */
export async function createPrivateFileExclusive(filePath: string, data: Uint8Array): Promise<void> {
  if (data.byteLength !== 32) {
    throw new Error(`Master-key material must be exactly 32 bytes (received ${data.byteLength})`);
  }

  const parent = path.dirname(filePath);
  if (path.parse(parent).root === parent) {
    throw new Error(`Master-key parent must not be a filesystem root: ${parent}`);
  }

  try {
    const stat = await fs.lstat(parent);
    if (stat.isSymbolicLink()) throw new Error(`Master-key parent must not be a symbolic link: ${parent}`);
    if (!stat.isDirectory()) throw new Error(`Master-key parent is not a directory: ${parent}`);
    if (os.platform() !== 'win32') {
      if ((stat.mode & 0o1000) !== 0 || (stat.mode & 0o022) !== 0) {
        throw new Error(
          `Master-key parent must not be shared or group/other-writable ` +
          `(found ${modeString(stat.mode)}): ${parent}`,
        );
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`Master-key parent must be owned by the current user: ${parent}`);
      }
      await fs.chmod(parent, 0o700);
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Master-key parent must be a real directory: ${parent}`);
    }
    if (os.platform() !== 'win32') await fs.chmod(parent, 0o700);
  }

  let created = false;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'wx', 0o600);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    if (created) await fs.unlink(filePath).catch(() => undefined);
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  if (os.platform() !== 'win32') await fs.chmod(filePath, 0o600);
  await assertPrivateFile(filePath, 'Master-key file');
}

export async function writePrivateTextFileAtomic(
  filePath: string,
  data: string,
  options: { label?: string; parentMode?: number } = {},
): Promise<void> {
  const parent = path.dirname(filePath);
  const parentMode = options.parentMode ?? 0o700;
  await fs.mkdir(parent, { recursive: true, mode: parentMode });
  if (options.parentMode !== undefined && os.platform() !== 'win32') {
    await fs.chmod(parent, parentMode);
  }

  const suffix = crypto.randomBytes(12).toString('hex');
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    if (os.platform() !== 'win32') await fs.chmod(filePath, 0o600);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }

  await assertPrivateFile(filePath, options.label ?? 'Private file');
}
