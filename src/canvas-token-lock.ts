import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_CANVAS_TOKEN_LOCK_ROOT = path.join(
  os.homedir(),
  '.eclass-mcp',
  'token-locks',
);

export interface CanvasTokenLockOptions {
  rootDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  staleMs?: number;
  hardStaleMs?: number;
  /** Deterministic delayed-publication coverage; production callers omit it. */
  testAfterCandidatePublished?: () => Promise<void>;
}

export interface CanvasTokenLock {
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

interface LockCandidate {
  filePath: string;
  fileName: string;
  owner: LockOwner | null;
  mtimeMs: number;
}

interface ResolvedLockOptions {
  rootDir: string;
  timeoutMs: number;
  pollMs: number;
  settleMs: number;
  staleMs: number;
  hardStaleMs: number;
}

const DEFAULT_OPTIONS: Omit<ResolvedLockOptions, 'rootDir'> = {
  timeoutMs: 180_000,
  pollMs: 75,
  settleMs: 25,
  staleMs: 30_000,
  hardStaleMs: 10 * 60_000,
};

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOptions(options: CanvasTokenLockOptions): ResolvedLockOptions {
  const resolved: ResolvedLockOptions = {
    rootDir: options.rootDir ?? DEFAULT_CANVAS_TOKEN_LOCK_ROOT,
    timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
    pollMs: options.pollMs ?? DEFAULT_OPTIONS.pollMs,
    settleMs: options.settleMs ?? DEFAULT_OPTIONS.settleMs,
    staleMs: options.staleMs ?? DEFAULT_OPTIONS.staleMs,
    hardStaleMs: options.hardStaleMs ?? DEFAULT_OPTIONS.hardStaleMs,
  };
  if (
    resolved.timeoutMs <= 0 ||
    resolved.pollMs <= 0 ||
    resolved.settleMs < 0 ||
    resolved.staleMs <= 0 ||
    resolved.hardStaleMs <= resolved.staleMs
  ) {
    throw new Error('Invalid Canvas token lock timing options');
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

export function canvasTokenLockBucketName(username: string): string {
  return crypto
    .createHash('sha256')
    .update('eclass-mcp\0canvas-token\0', 'utf8')
    .update(username, 'utf8')
    .digest('hex');
}

export function canvasTokenLockBucketPath(
  username: string,
  rootDir: string = DEFAULT_CANVAS_TOKEN_LOCK_ROOT,
): string {
  return path.join(rootDir, canvasTokenLockBucketName(username));
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

async function readCandidate(bucketPath: string, fileName: string): Promise<LockCandidate | null> {
  const filePath = path.join(bucketPath, fileName);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { filePath, fileName, owner: null, mtimeMs: stat.mtimeMs };
    }
    const raw = await fs.readFile(filePath, 'utf8');
    return { filePath, fileName, owner: parseOwner(raw), mtimeMs: stat.mtimeMs };
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
    // EPERM means the process exists but cannot be signalled. Unknown failures
    // are treated as live so lock recovery fails closed.
    return true;
  }
}

function hostnameHash(hostname: string): string {
  return crypto.createHash('sha256').update(hostname, 'utf8').digest('hex').slice(0, 16);
}

function candidateIdentity(fileName: string): { hostHash: string; pid: number } | null {
  const match = /^([a-f0-9]{16})-(\d+)-[a-f0-9]{32}\.lock$/.exec(fileName);
  if (!match) return null;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 ? { hostHash: match[1], pid } : null;
}

function isCandidateActive(
  candidate: LockCandidate,
  nowMs: number,
  options: ResolvedLockOptions,
): boolean {
  const ageMs = Math.max(0, nowMs - candidate.mtimeMs);
  if (ageMs <= options.staleMs) return true;
  if (!candidate.owner) {
    const identity = candidateIdentity(candidate.fileName);
    if (identity?.hostHash === hostnameHash(os.hostname())) {
      return isProcessAlive(identity.pid);
    }
    return ageMs <= options.hardStaleMs;
  }

  if (candidate.owner.hostname === os.hostname()) {
    // Never steal from a live same-host PID. Suspend/resume can delay heartbeat
    // well past hardStaleMs while the original critical section is still live.
    return isProcessAlive(candidate.owner.pid);
  }
  // The default lock root is local. For an explicitly shared root, a foreign
  // host gets the full hard-stale window because its PID cannot be probed.
  return ageMs <= options.hardStaleMs;
}

function compareCandidates(left: LockCandidate, right: LockCandidate): number {
  // A published-but-not-initialized candidate may belong to a process paused
  // immediately after O_EXCL creation. It blocks initialized candidates until
  // it publishes a post-creation order or is proven stale.
  if (!left.owner && right.owner) return -1;
  if (left.owner && !right.owner) return 1;
  if (
    left.owner &&
    right.owner &&
    left.owner.hostname === right.owner.hostname
  ) {
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
  options: ResolvedLockOptions,
): Promise<LockCandidate[]> {
  const fileNames = (await fs.readdir(bucketPath)).filter((name) => name.endsWith('.lock'));
  const candidates = (await Promise.all(
    fileNames.map((name) => readCandidate(bucketPath, name)),
  )).filter((candidate): candidate is LockCandidate => candidate !== null);

  const nowMs = Date.now();
  const active: LockCandidate[] = [];
  for (const candidate of candidates) {
    if (isCandidateActive(candidate, nowMs, options)) {
      active.push(candidate);
    } else {
      // Candidate paths contain an unguessable nonce and are never reused, so
      // stale cleanup cannot remove a newly-created owner's file.
      await fs.unlink(candidate.filePath).catch(() => undefined);
    }
  }
  return active.sort(compareCandidates);
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

export async function acquireCanvasTokenLock(
  username: string,
  rawOptions: CanvasTokenLockOptions = {},
): Promise<CanvasTokenLock> {
  if (!username.trim()) throw new Error('Canvas token lock requires a username');
  const options = resolveOptions(rawOptions);
  if (path.resolve(options.rootDir) === path.resolve(DEFAULT_CANVAS_TOKEN_LOCK_ROOT)) {
    await ensurePrivateDirectory(path.dirname(options.rootDir), 'Canvas token lock parent');
  }
  await ensurePrivateDirectory(options.rootDir, 'Canvas token lock root');
  const bucketPath = canvasTokenLockBucketPath(username, options.rootDir);
  await ensurePrivateDirectory(bucketPath, 'Canvas token lock bucket');

  const nonce = crypto.randomBytes(16).toString('hex');
  const host = os.hostname();
  const candidatePath = path.join(
    bucketPath,
    `${hostnameHash(host)}-${process.pid}-${nonce}.lock`,
  );
  const handle = await fs.open(candidatePath, 'wx', 0o600);
  let owner: LockOwner;
  try {
    // Publication happens before ordering. Therefore a process paused here is
    // visible as an invalid blocking candidate; when it resumes, its order is
    // necessarily later than every owner that initialized in the meantime.
    await rawOptions.testAfterCandidatePublished?.();
    owner = {
      version: 1,
      pid: process.pid,
      hostname: host,
      nonce,
      created_at_ms: Date.now(),
      monotonic_ns: process.hrtime.bigint().toString(),
    };
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.unlink(candidatePath).catch(() => undefined);
    throw err;
  } finally {
    await handle.close().catch(() => undefined);
  }

  const assertOwned = async (): Promise<void> => {
    const current = await readOwner(candidatePath);
    if (!current || current.nonce !== nonce || current.pid !== process.pid) {
      throw new Error('Canvas token interprocess lock ownership was lost');
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
    if (options.settleMs > 0) await delay(options.settleMs);
    while (true) {
      await assertOwned();
      const active = await activeCandidates(bucketPath, options);
      if (active[0]?.filePath === candidatePath) {
        // Confirm once more after a short election window. Candidates created
        // later on this host have a greater monotonic timestamp and cannot
        // preempt the confirmed owner.
        if (options.settleMs > 0) await delay(options.settleMs);
        const confirmed = await activeCandidates(bucketPath, options);
        if (confirmed[0]?.filePath === candidatePath) break;
      }
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting for Canvas token lock (${options.timeoutMs}ms)`);
      }
      await delay(options.pollMs);
    }
    await assertOwned();
    const heartbeatMs = Math.max(5, Math.floor(options.staleMs / 3));
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

export async function withCanvasTokenLock<T>(
  username: string,
  fn: (lock: CanvasTokenLock) => Promise<T>,
  options: CanvasTokenLockOptions = {},
): Promise<T> {
  const lock = await acquireCanvasTokenLock(username, options);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
