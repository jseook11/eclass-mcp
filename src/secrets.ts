import { getCredential } from './credential-store.js';

export const KEYCHAIN_SERVICE = 'eclass-mcp';
export const PLAINTEXT_ENV_OVERRIDE_FLAG = 'ALLOW_PLAINTEXT_ENV_SECRETS';

type PasswordGetter = (service: string, account: string) => Promise<string | null>;

function isPlaintextEnvOverrideEnabled(
  raw: string | undefined = process.env[PLAINTEXT_ENV_OVERRIDE_FLAG],
): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function getEnvSecret(
  raw: string | undefined,
  plaintextOverrideRaw: string | undefined = process.env[PLAINTEXT_ENV_OVERRIDE_FLAG],
): string | null {
  if (!isPlaintextEnvOverrideEnabled(plaintextOverrideRaw)) return null;
  const value = raw?.trim();
  return value && value.length > 0 ? value : null;
}

async function getSecretFromKeychain(
  account: string,
  passwordGetter: PasswordGetter = getCredential,
): Promise<string | null> {
  const secret = await passwordGetter(KEYCHAIN_SERVICE, account);
  const value = secret?.trim();
  return value && value.length > 0 ? value : null;
}

export function getSecretEnvWarning(
  envName: string,
  label: string,
  envValue: string | undefined = process.env[envName],
): string | null {
  if (!envValue?.trim()) return null;
  if (isPlaintextEnvOverrideEnabled()) {
    return `[eclass-mcp] WARNING: ${envName} 환경 변수가 설정되어 있습니다. ` +
      `${label}가 Keychain 대신 env에서 로드됩니다. 임시 디버그용이 아니면 제거하세요.\n`;
  }
  return `[eclass-mcp] WARNING: ${envName} 환경 변수가 설정되어 있지만 무시됩니다. ` +
    `plaintext env override가 필요하면 ${PLAINTEXT_ENV_OVERRIDE_FLAG}=1 을 명시하세요.\n`;
}

export function isDebugLoggingEnabled(raw: string | undefined = process.env.DEBUG): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

export function debugLog(scope: string, message: string): void {
  if (!isDebugLoggingEnabled()) return;
  process.stderr.write(`[${scope}] ${message}\n`);
}

export async function getEclassPassword(
  username: string,
  envPassword: string | undefined = process.env.ECLASS_PASSWORD,
  passwordGetter: PasswordGetter = getCredential,
  plaintextOverrideRaw: string | undefined = process.env[PLAINTEXT_ENV_OVERRIDE_FLAG],
): Promise<string> {
  const envSecret = getEnvSecret(envPassword, plaintextOverrideRaw);
  if (envSecret) return envSecret;

  const keychainSecret = await getSecretFromKeychain(username, passwordGetter);
  if (keychainSecret) return keychainSecret;

  throw new Error('Password not found in credential store — run npm run setup');
}
