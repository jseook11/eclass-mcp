import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
    const raw = await fs.readFile(expandTilde(keyFile));
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

async function readSecretFile(): Promise<SecretFile> {
  try {
    const raw = await fs.readFile(getSecretStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SecretFile;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSecretFile(file: SecretFile): Promise<void> {
  const storePath = getSecretStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    path.dirname(storePath),
    `.${path.basename(storePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tmpPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmpPath, storePath);
  if (os.platform() !== 'win32') {
    await fs.chmod(storePath, 0o600);
  }
}

function getEncStorePath(): string {
  return expandTilde(process.env[ENC_STORE_PATH_ENV] ?? DEFAULT_ENC_STORE_PATH);
}

async function readEncFile(key: Buffer): Promise<SecretFile> {
  try {
    const raw = await fs.readFile(getEncStorePath(), 'utf8');
    const enc = JSON.parse(raw) as EncFile;
    return decryptSecretFile(key, enc);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeEncFile(key: Buffer, data: SecretFile): Promise<void> {
  const storePath = getEncStorePath();
  await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    path.dirname(storePath),
    `.${path.basename(storePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tmpPath, JSON.stringify(encryptSecretFile(key, data), null, 2) + '\n', {
    mode: 0o600,
  });
  await fs.rename(tmpPath, storePath);
  if (os.platform() !== 'win32') await fs.chmod(storePath, 0o600);
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
  // auto
  if (await resolveMasterKey()) return { backend: 'encrypted', reason: 'auto: master key present' };
  if (await loadKeytar()) return { backend: 'keytar', reason: 'auto: keytar available' };
  return { backend: 'file', reason: 'auto: no key and keytar unavailable' };
}

export type CredentialDiagnostics = {
  backend: CredentialBackend;
  reason: string;
  keytarLoaded: boolean;
  keytarError: string | null;
  masterKeyPresent: boolean;
  dbusSession: boolean;
  platform: NodeJS.Platform;
};

export async function describeCredentialEnvironment(): Promise<CredentialDiagnostics> {
  let backend: CredentialBackend;
  let reason: string;
  try {
    ({ backend, reason } = await resolveBackend());
  } catch (err) {
    backend = 'file';
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

export async function getCredential(service: string, account: string): Promise<string | null> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const file = await readEncFile(key);
    return file[encodeKey(service)]?.[encodeKey(account)] ?? null;
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    try {
      return (await keytar!.getPassword(service, account)) ?? null;
    } catch {
      return null;
    }
  }
  const file = await readSecretFile();
  return file[encodeKey(service)]?.[encodeKey(account)] ?? null;
}

export async function setCredential(
  service: string,
  account: string,
  password: string,
  options: { allowFileFallback?: boolean } = {},
): Promise<CredentialBackend> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const file = await readEncFile(key);
    (file[encodeKey(service)] ??= {})[encodeKey(account)] = password;
    await writeEncFile(key, file);
    return 'encrypted';
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    try {
      await keytar!.setPassword(service, account, password);
      return 'keytar';
    } catch (err) {
      if (options.allowFileFallback === false) throw err;
    }
  }
  // 여기 도달 = encrypted/keytar 성공 경로를 모두 지나 평문 파일 store 에 쓰기 직전.
  // allowFileFallback:false 면 백엔드 해석 결과(명시적 file 포함)와 무관하게 거부한다.
  if (options.allowFileFallback === false) {
    throw new Error(
      'Refusing to store secret in the plaintext file backend ' +
      '(set ECLASS_CREDENTIAL_BACKEND=encrypted with ECLASS_SECRET_KEY, or make keytar available)',
    );
  }
  const file = await readSecretFile();
  (file[encodeKey(service)] ??= {})[encodeKey(account)] = password;
  await writeSecretFile(file);
  return 'file';
}

export async function deleteCredential(service: string, account: string): Promise<void> {
  const { backend } = await resolveBackend();
  if (backend === 'encrypted') {
    const key = (await resolveMasterKey())!;
    const file = await readEncFile(key);
    delete file[encodeKey(service)]?.[encodeKey(account)];
    await writeEncFile(key, file);
    return;
  }
  if (backend === 'keytar') {
    const keytar = await loadKeytar();
    try {
      await keytar!.deletePassword(service, account);
      return;
    } catch {
      // fall through to file cleanup
    }
  }
  const file = await readSecretFile();
  delete file[encodeKey(service)]?.[encodeKey(account)];
  await writeSecretFile(file);
}
