import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const LOCK_ROOT_DIRECTORY_NAME = '.eclass-mcp-credential-store-locks';

export interface CredentialStoreLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
}

export interface CredentialStoreLock {
  readonly bucketPath: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface LockOwner {
  version: 1;
  pid: number;
  hostname: string;
  nonce: string;
  created_at_ms: number;
  monotonic_ns: string;
}

interface Candidate {
  filePath: string;
  fileName: string;
  state: 'pending' | 'ready';
  owner: LockOwner | null;
  pidHint: number | null;
  mtimeMs: number;
}

interface ResolvedOptions {
  timeoutMs: number;
  pollMs: number;
  staleMs: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  timeoutMs: 60_000,
  pollMs: 50,
  staleMs: 30_000,
};

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOptions(options: CredentialStoreLockOptions): ResolvedOptions {
  const resolved = {
    timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
    pollMs: options.pollMs ?? DEFAULT_OPTIONS.pollMs,
    staleMs: options.staleMs ?? DEFAULT_OPTIONS.staleMs,
  };
  if (resolved.timeoutMs <= 0 || resolved.pollMs <= 0 || resolved.staleMs <= 0) {
    throw new Error('Invalid encrypted credential-store lock timing options');
  }
  return resolved;
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  if (path.parse(directory).root === directory) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  if (
    os.platform() !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }
  if (os.platform() !== 'win32') await fs.chmod(directory, 0o700);
}

async function canonicalStoreIdentity(storePath: string): Promise<{
  canonicalParent: string;
  identity: string;
}> {
  const absolutePath = path.resolve(storePath);
  const canonicalParent = await fs.realpath(path.dirname(absolutePath));
  const basename = os.platform() === 'win32' || os.platform() === 'darwin'
    ? path.basename(absolutePath).toLocaleLowerCase('en-US')
    : path.basename(absolutePath);
  return { canonicalParent, identity: `path\0${canonicalParent}\0${basename}` };
}

/**
 * Lock queues are keyed by a canonical-parent path identity that remains
 * stable before and after the store is first created. Only a SHA-256 bucket
 * name is exposed on disk, never the configured secret-store filename.
 */
export async function credentialStoreLockBucketPath(storePath: string): Promise<string> {
  const { canonicalParent, identity } = await canonicalStoreIdentity(storePath);
  const bucketName = crypto
    .createHash('sha256')
    .update('eclass-mcp\0credential-store\0', 'utf8')
    .update(identity, 'utf8')
    .digest('hex');
  return path.join(canonicalParent, LOCK_ROOT_DIRECTORY_NAME, bucketName);
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.hostname !== 'string' ||
      parsed.hostname.length === 0 ||
      typeof parsed.nonce !== 'string' ||
      !/^[a-f0-9]{32}$/.test(parsed.nonce) ||
      !Number.isFinite(parsed.created_at_ms) ||
      (parsed.created_at_ms ?? 0) <= 0 ||
      typeof parsed.monotonic_ns !== 'string' ||
      !/^\d+$/.test(parsed.monotonic_ns)
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function parseCandidateName(fileName: string): { pid: number | null; state: Candidate['state'] } | null {
  const match = /^(\d+)-[a-f0-9]{32}\.(pending|lock)$/.exec(fileName);
  if (!match) return null;
  const pid = Number(match[1]);
  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    state: match[2] === 'pending' ? 'pending' : 'ready',
  };
}

async function readCandidate(bucketPath: string, fileName: string): Promise<Candidate | null> {
  const parsedName = parseCandidateName(fileName);
  if (!parsedName) return null;
  const filePath = path.join(bucketPath, fileName);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return {
        filePath,
        fileName,
        state: parsedName.state,
        owner: null,
        pidHint: parsedName.pid,
        mtimeMs: stat.mtimeMs,
      };
    }
    const owner = parseOwner(await fs.readFile(filePath, 'utf8'));
    return {
      filePath,
      fileName,
      state: parsedName.state,
      owner,
      pidHint: parsedName.pid,
      mtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrno(err, 'ESRCH')) return false;
    // EPERM and unknown probe failures fail closed: the process may be live.
    return true;
  }
}

function candidateCanBeRecovered(
  candidate: Candidate,
  nowMs: number,
  options: ResolvedOptions,
): boolean {
  if (Math.max(0, nowMs - candidate.mtimeMs) <= options.staleMs) return false;

  if (candidate.owner) {
    // A foreign host's process cannot be proved dead locally, so it is never
    // automatically removed. Acquisition still fails at the bounded timeout.
    if (candidate.owner.hostname !== os.hostname()) return false;
    return !isProcessAlive(candidate.owner.pid);
  }

  // A process can die after publishing the empty pending file but before its
  // metadata is durable. The PID embedded in the unique filename lets that
  // exact orphan be recovered without guessing or touching another owner.
  return candidate.pidHint !== null && !isProcessAlive(candidate.pidHint);
}

function compareReadyCandidates(left: Candidate, right: Candidate): number {
  if (left.owner && right.owner && left.owner.hostname === right.owner.hostname) {
    const leftMonotonic = BigInt(left.owner.monotonic_ns);
    const rightMonotonic = BigInt(right.owner.monotonic_ns);
    if (leftMonotonic < rightMonotonic) return -1;
    if (leftMonotonic > rightMonotonic) return 1;
  }
  const leftCreated = left.owner?.created_at_ms ?? left.mtimeMs;
  const rightCreated = right.owner?.created_at_ms ?? right.mtimeMs;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return left.fileName.localeCompare(right.fileName);
}

async function activeCandidates(
  bucketPath: string,
  options: ResolvedOptions,
): Promise<{ pending: Candidate[]; ready: Candidate[] }> {
  const candidates = (await Promise.all(
    (await fs.readdir(bucketPath)).map((fileName) => readCandidate(bucketPath, fileName)),
  )).filter((candidate): candidate is Candidate => candidate !== null);

  const nowMs = Date.now();
  const active: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidateCanBeRecovered(candidate, nowMs, options)) {
      // Candidate names carry an unguessable nonce and are never reused. It is
      // therefore safe to unlink this dead process's exact path; a successor
      // can never appear at the same path between inspection and cleanup.
      await fs.unlink(candidate.filePath).catch((err: unknown) => {
        if (!isErrno(err, 'ENOENT')) throw err;
      });
    } else {
      active.push(candidate);
    }
  }

  return {
    pending: active.filter((candidate) => candidate.state === 'pending'),
    ready: active
      .filter((candidate) => candidate.state === 'ready')
      .sort(compareReadyCandidates),
  };
}

async function readOwner(filePath: string): Promise<LockOwner | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return parseOwner(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

export async function acquireCredentialStoreLock(
  storePath: string,
  rawOptions: CredentialStoreLockOptions = {},
): Promise<CredentialStoreLock> {
  const options = resolveOptions(rawOptions);
  const parent = path.dirname(path.resolve(storePath));
  await ensurePrivateDirectory(parent, 'Credential-store parent');
  const bucketPath = await credentialStoreLockBucketPath(storePath);
  await ensurePrivateDirectory(path.dirname(bucketPath), 'Credential-store lock root');
  await ensurePrivateDirectory(bucketPath, 'Credential-store lock directory');

  const nonce = crypto.randomBytes(16).toString('hex');
  const pendingPath = path.join(bucketPath, `${process.pid}-${nonce}.pending`);
  let candidatePath = pendingPath;
  let handle: fs.FileHandle | undefined = await fs.open(pendingPath, 'wx', 0o600);
  let owner: LockOwner;
  try {
    // The pending file is visible before ordering metadata is chosen. Other
    // contenders wait for all live pending publications, preventing a delayed
    // publisher from later pre-empting an already-entered transaction.
    owner = {
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      nonce,
      created_at_ms: Date.now(),
      monotonic_ns: process.hrtime.bigint().toString(),
    };
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const readyPath = path.join(bucketPath, `${process.pid}-${nonce}.lock`);
    await fs.rename(pendingPath, readyPath);
    candidatePath = readyPath;
    if (os.platform() !== 'win32') await fs.chmod(candidatePath, 0o600);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(candidatePath).catch(() => undefined);
    if (candidatePath !== pendingPath) await fs.unlink(pendingPath).catch(() => undefined);
    throw err;
  }

  const assertOwned = async (): Promise<void> => {
    const current = await readOwner(candidatePath);
    if (!current || current.nonce !== nonce || current.pid !== process.pid) {
      throw new Error('Encrypted credential-store lock ownership was lost');
    }
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    const current = await readOwner(candidatePath);
    if (current?.nonce === nonce && current.pid === process.pid) {
      await fs.unlink(candidatePath).catch((err: unknown) => {
        if (!isErrno(err, 'ENOENT')) throw err;
      });
    }
  };

  try {
    const startedAt = Date.now();
    while (true) {
      await assertOwned();
      const active = await activeCandidates(bucketPath, options);
      const allReadyCandidatesAreLocal = active.ready.every(
        (candidate) => candidate.owner?.hostname === os.hostname(),
      );
      if (
        active.pending.length === 0 &&
        allReadyCandidatesAreLocal &&
        active.ready[0]?.filePath === candidatePath
      ) {
        break;
      }
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(
          `Timed out waiting for encrypted credential-store lock (${options.timeoutMs}ms)`,
        );
      }
      await delay(options.pollMs);
    }

    await assertOwned();
    const heartbeatMs = Math.max(10, Math.floor(options.staleMs / 3));
    heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(candidatePath, now, now).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref();
    return { bucketPath, assertOwned, release };
  } catch (err) {
    await release().catch(() => undefined);
    throw err;
  }
}

export async function withCredentialStoreLock<T>(
  storePath: string,
  fn: (lock: CredentialStoreLock) => Promise<T>,
  options: CredentialStoreLockOptions = {},
): Promise<T> {
  const lock = await acquireCredentialStoreLock(storePath, options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
