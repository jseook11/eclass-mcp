import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertPrivateFile,
  assertPrivateFileIfExists,
  writePrivateTextFileAtomic,
} from './private-file.js';
import { withCredentialStoreLock } from './credential-store-lock.js';
import { expandTilde } from './utils.js';

export const DEFAULT_SECRET_STORE_PATH = '~/.eclass-mcp/secrets.json';
export const CREDENTIAL_BACKEND_ENV = 'ECLASS_CREDENTIAL_BACKEND';
export const DEFAULT_ENC_STORE_PATH = '~/.eclass-mcp/secrets.enc';
export const ENC_STORE_PATH_ENV = 'ECLASS_ENC_STORE_PATH';
export const SECRET_KEY_ENV = 'ECLASS_SECRET_KEY';
export const SECRET_KEY_FILE_ENV = 'ECLASS_SECRET_KEY_FILE';

export type CredentialBackend = 'keytar' | 'file' | 'encrypted';

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

type SecretFile = Record<string, Record<string, string>>;

export type EncFile = { v: 1; iv: string; tag: string; ct: string };

export function encryptSecretFile(key: Buffer, data: SecretFile): EncFile {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(data), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecretFile(key: Buffer, enc: EncFile): SecretFile {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as SecretFile;
}

function decodeBase64Key(value: string): Buffer {
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${SECRET_KEY_ENV} must be base64 of 32 bytes (decoded ${buf.length})`);
  }
  return buf;
}

export async function resolveMasterKey(): Promise<Buffer | null> {
  const envKey = process.env[SECRET_KEY_ENV]?.trim();
  if (envKey) return decodeBase64Key(envKey);

  const keyFile = process.env[SECRET_KEY_FILE_ENV]?.trim();
  if (keyFile) {
    const resolved = expandTilde(keyFile);
    await assertPrivateFile(resolved, SECRET_KEY_FILE_ENV);
    const raw = await fs.readFile(resolved);
    if (raw.length === 32) return raw; // raw 32-byte key
    return decodeBase64Key(raw.toString('utf8').trim()); // otherwise base64 text
  }

  return null;
}

let keytarLoad: Promise<KeytarModule | null> | null = null;
let keytarLoadError: string | null = null;

async function loadKeytar(): Promise<KeytarModule | null> {
  if (process.env[CREDENTIAL_BACKEND_ENV] === 'file') return null;
  keytarLoad ??= import('keytar')
    .then((mod) => (mod.default ?? mod) as KeytarModule)
    .catch((err) => {
      keytarLoadError = err instanceof Error ? err.message : String(err);
      return null;
    });
  return keytarLoad;
}

function getSecretStorePath(): string {
  return expandTilde(process.env.ECLASS_SECRET_STORE_PATH ?? DEFAULT_SECRET_STORE_PATH);
}

function encodeKey(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

async function canonicalConfiguredPath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    return await fs.realpath(absolutePath);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
    try {
      const canonicalParent = await fs.realpath(path.dirname(absolutePath));
      const basename = os.platform() === 'win32' || os.platform() === 'darwin'
        ? path.basename(absolutePath).toLocaleLowerCase('en-US')
        : path.basename(absolutePath);
      return path.join(canonicalParent, basename);
    } catch (parentErr) {
      if (!isErrno(parentErr, 'ENOENT')) throw parentErr;
      return os.platform() === 'win32' || os.platform() === 'darwin'
        ? absolutePath.toLocaleLowerCase('en-US')
        : absolutePath;
    }
  }
}

async function assertEncryptedAndLegacyStoresDiffer(encryptedPath: string): Promise<void> {
  const legacyPath = getSecretStorePath();
  const [canonicalEncrypted, canonicalLegacy] = await Promise.all([
    canonicalConfiguredPath(encryptedPath),
    canonicalConfiguredPath(legacyPath),
  ]);
  if (canonicalEncrypted === canonicalLegacy) {
    throw new Error(
      `${ENC_STORE_PATH_ENV} and ECLASS_SECRET_STORE_PATH must refer to different files`,
    );
  }

  try {
    const [encryptedStat, legacyStat] = await Promise.all([
      fs.stat(encryptedPath),
      fs.stat(legacyPath),
    ]);
    if (encryptedStat.dev === legacyStat.dev && encryptedStat.ino === legacyStat.ino) {
      throw new Error(
        `${ENC_STORE_PATH_ENV} and ECLASS_SECRET_STORE_PATH must not be hard links to the same file`,
      );
    }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return;
    throw err;
  }
}

async function readSecretFile(storePath = getSecretStorePath()): Promise<SecretFile> {
  if (!(await assertPrivateFileIfExists(storePath, 'Plaintext legacy credential file'))) return {};
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SecretFile;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function ensureStoreParentPrivate(storePath: string): Promise<void> {
  const parent = path.dirname(storePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (os.platform() === 'win32') return;

  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Credential-store parent must be a real directory: ${parent}`);
  }
  if ((stat.mode & 0o1000) !== 0 || parent === path.parse(parent).root) {
    throw new Error(`Refusing to use a shared/root directory as credential-store parent: ${parent}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Credential-store parent is not owned by the current user: ${parent}`);
  }
  await fs.chmod(parent, 0o700);
}

async function writeSecretFile(
  file: SecretFile,
  storePath = getSecretStorePath(),
): Promise<void> {
  await ensureStoreParentPrivate(storePath);
  await writePrivateTextFileAtomic(storePath, JSON.stringify(file, null, 2) + '\n', {
    label: 'Plaintext legacy credential file',
    parentMode: 0o700,
  });
}

function getEncStorePath(): string {
  return expandTilde(process.env[ENC_STORE_PATH_ENV] ?? DEFAULT_ENC_STORE_PATH);
}

async function readEncFile(key: Buffer, storePath = getEncStorePath()): Promise<SecretFile> {
  if (!(await assertPrivateFileIfExists(storePath, 'Encrypted credential file'))) return {};
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const enc = JSON.parse(raw) as EncFile;
    return decryptSecretFile(key, enc);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeEncFile(
  key: Buffer,
  data: SecretFile,
  storePath = getEncStorePath(),
): Promise<void> {
  await ensureStoreParentPrivate(storePath);
  await writePrivateTextFileAtomic(
    storePath,
    JSON.stringify(encryptSecretFile(key, data), null, 2) + '\n',
    {
      label: 'Encrypted credential file',
      parentMode: 0o700,
    },
  );
}

export async function resolveBackend(): Promise<{ backend: CredentialBackend; reason: string }> {
  const explicit = process.env[CREDENTIAL_BACKEND_ENV];
  if (explicit === 'encrypted') {
    if (!(await resolveMasterKey())) {
      throw new Error(
        `${CREDENTIAL_BACKEND_ENV}=encrypted but no master key (set ${SECRET_KEY_ENV} or ${SECRET_KEY_FILE_ENV})`,
      );
    }
    return { backend: 'encrypted', reason: 'explicit' };
  }
  if (explicit === 'keytar') {
    if (!(await loadKeytar())) {
      throw new Error(
        `${CREDENTIAL_BACKEND_ENV}=keytar but keytar is unavailable: ${keytarLoadError ?? 'load failed'}`,
      );
    }
    return { backend: 'keytar', reason: 'explicit' };
  }
  if (explicit === 'file') return { backend: 'file', reason: 'explicit' };
  if (explicit) {
    throw new Error(`${CREDENTIAL_BACKEND_ENV} must be one of encrypted, keytar, or file`);
  }
  // auto
  if (await resolveMasterKey()) return { backend: 'encrypted', reason: 'auto: master key present' };
  if (await loadKeytar()) return { backend: 'keytar', reason: 'auto: keytar available' };
  throw new Error(
    'No secure credential backend is available. Configure keytar, or set ' +
    `${CREDENTIAL_BACKEND_ENV}=encrypted with ${SECRET_KEY_ENV} or ${SECRET_KEY_FILE_ENV}. ` +
    `The plaintext file backend is legacy read-only and must be selected explicitly.`,
  );
}

export type CredentialDiagnostics = {
  backend: CredentialBackend | 'unavailable';
  reason: string;
  keytarLoaded: boolean;
  keytarError: string | null;
  masterKeyPresent: boolean;
  dbusSession: boolean;
  platform: NodeJS.Platform;
};

export async function describeCredentialEnvironment(): Promise<CredentialDiagnostics> {
  let backend: CredentialDiagnostics['backend'];
  let reason: string;
  try {
    ({ backend, reason } = await resolveBackend());
  } catch (err) {
    backend = 'unavailable';
    reason = err instanceof Error ? `unresolved: ${err.message}` : 'unresolved';
  }
  const keytar = await loadKeytar();
  let masterKeyPresent = false;
  try {
    masterKeyPresent = (await resolveMasterKey()) !== null;
  } catch {
    masterKeyPresent = false; // malformed key
  }
  return {
    backend,
    reason,
    keytarLoaded: keytar !== null,
    keytarError: keytarLoadError,
    masterKeyPresent,
    dbusSession: Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
    platform: os.platform(),
  };
}

export async function getCredentialBackend(): Promise<CredentialBackend> {
  return (await resolveBackend()).backend;
}

async function purgePlaintextDuplicate(service: string, account: string): Promise<void> {
  const storePath = getSecretStorePath();
  if (!(await assertPrivateFileIfExists(storePath, 'Plaintext legacy credential file'))) return;
  await ensureStoreParentPrivate(storePath);
  await withCredentialStoreLock(storePath, async (lock) => {
    await lock.assertOwned();
    if (!(await assertPrivateFileIfExists(storePath, 'Plaintext legacy credential file'))) return;
    const file = await readSecretFile(storePath);
    const serviceKey = encodeKey(service);
    const accountKey = encodeKey(account);
    const accounts = file[serviceKey];
    if (!accounts || accounts[accountKey] === undefined) return;

    delete accounts[accountKey];
    if (Object.keys(accounts).length === 0) delete file[serviceKey];
    await lock.assertOwned();
    if (Object.keys(file).length === 0) {
      await fs.unlink(storePath);
      return;
    }
    await writeSecretFile(file, storePath);
  });
}

export async function readKeytarCredential(
  keytar: Pick<KeytarModule, 'getPassword'>,
  service: string,
  account: string,
): Promise<string | null> {
  return (await keytar.getPassword(service, account)) ?? null;
}

export async function getCredential(service: string, account: string): Promise<string | null> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const file = await readEncFile(key);
    return file[encodeKey(service)]?.[encodeKey(account)] ?? null;
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    return readKeytarCredential(keytar!, service, account);
  }
  const file = await readSecretFile();
  return file[encodeKey(service)]?.[encodeKey(account)] ?? null;
}

export async function setCredential(
  service: string,
  account: string,
  password: string,
  _options: { allowFileFallback?: boolean } = {},
): Promise<CredentialBackend> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const storePath = getEncStorePath();
    await assertEncryptedAndLegacyStoresDiffer(storePath);
    await ensureStoreParentPrivate(storePath);
    await withCredentialStoreLock(storePath, async (lock) => {
      await lock.assertOwned();
      const file = await readEncFile(key, storePath);
      (file[encodeKey(service)] ??= {})[encodeKey(account)] = password;
      await lock.assertOwned();
      await writeEncFile(key, file, storePath);
      await lock.assertOwned();
      const verified = (await readEncFile(key, storePath))[encodeKey(service)]?.[encodeKey(account)];
      if (verified !== password) throw new Error('Encrypted credential write verification failed');
      await purgePlaintextDuplicate(service, account);
    });
    return 'encrypted';
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    await keytar!.setPassword(service, account, password);
    const verified = await keytar!.getPassword(service, account);
    if (verified !== password) throw new Error('Keytar credential write verification failed');
    await purgePlaintextDuplicate(service, account);
    return 'keytar';
  }
  throw new Error(
    'The plaintext file backend is legacy read-only. Migrate to keytar or the encrypted backend before writing credentials.',
  );
}

export async function deleteCredential(service: string, account: string): Promise<void> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const storePath = getEncStorePath();
    await assertEncryptedAndLegacyStoresDiffer(storePath);
    await ensureStoreParentPrivate(storePath);
    await withCredentialStoreLock(storePath, async (lock) => {
      await lock.assertOwned();
      const file = await readEncFile(key, storePath);
      const serviceKey = encodeKey(service);
      const accounts = file[serviceKey];
      if (accounts) {
        delete accounts[encodeKey(account)];
        if (Object.keys(accounts).length === 0) delete file[serviceKey];
      }
      await lock.assertOwned();
      await writeEncFile(key, file, storePath);
      await lock.assertOwned();
      const verified = (await readEncFile(key, storePath))[encodeKey(service)]?.[encodeKey(account)];
      if (verified !== undefined) throw new Error('Encrypted credential delete verification failed');
      await purgePlaintextDuplicate(service, account);
    });
    return;
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    await keytar!.deletePassword(service, account);
    if ((await keytar!.getPassword(service, account)) !== null) {
      throw new Error('Keytar credential delete verification failed');
    }
    await purgePlaintextDuplicate(service, account);
    return;
  }
  throw new Error(
    'The plaintext file backend is legacy read-only. Migrate it before deleting credentials.',
  );
}
