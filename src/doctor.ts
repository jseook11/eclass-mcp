import { chromium } from 'playwright';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { BrowserSession } from './browser-session.js';
import { getEclassPassword, KEYCHAIN_SERVICE } from './secrets.js';
import { describeCredentialEnvironment, getCredential } from './credential-store.js';
import {
  defaultHermesConfigPath,
  defaultMcpJsonPath,
  readHermesCredentialEnv,
  readMcpJsonCredentialEnv,
} from './mcp-config.js';
import { getCourses } from './tools/get-courses.js';
import { sanitizeDebug } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function formatErrorDetail(err: unknown): string {
  // sanitizeDebug: URL 쿼리스트링(LTI/SSO 토큰 가능)을 제거한 뒤 노출
  if (err instanceof Error) return sanitizeDebug(err.message);
  if (typeof err === 'string') return sanitizeDebug(err);
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}') return sanitizeDebug(serialized);
  } catch {
    // ignore
  }
  return sanitizeDebug(inspect(err, { depth: 2, breakLength: 120 }));
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkPlaywright(): Promise<CheckResult> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const version = browser.version();
    return {
      name: 'Playwright Chromium',
      ok: true,
      detail: version ? `launch ok (${version})` : 'launch ok',
    };
  } catch (err) {
    const message = formatErrorDetail(err);
    return { name: 'Playwright Chromium', ok: false, detail: message };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function checkEclassPlaywright(session: BrowserSession): Promise<CheckResult> {
  try {
    await session.ensurePlaywrightReady();
    return { name: 'eclass Playwright', ok: true, detail: 'Chromium launch ok' };
  } catch (err) {
    const message = formatErrorDetail(err);
    return { name: 'eclass Playwright', ok: false, detail: message };
  }
}

async function checkEclassAuth(session: BrowserSession): Promise<CheckResult> {
  try {
    const result = await session.ensureAuthenticated();
    const sourceLabel = result.token_source === 'cache' ? 'cached token reused' : 'login and token refresh ok';
    return { name: 'eclass auth', ok: true, detail: sourceLabel };
  } catch (err) {
    const message = formatErrorDetail(err);
    return { name: 'eclass auth', ok: false, detail: message };
  }
}

async function checkEclassCoursesApi(session: BrowserSession): Promise<CheckResult> {
  try {
    const client = await session.getClient();
    const courses = await getCourses(client);
    return { name: 'eclass courses API', ok: true, detail: `current courses: ${courses.length}` };
  } catch (err) {
    const message = formatErrorDetail(err);
    return { name: 'eclass courses API', ok: false, detail: message };
  }
}

async function checkEclassCourseresource(session: BrowserSession): Promise<CheckResult> {
  try {
    const result = await session.probeCourseresource();
    if (result.skipped) {
      return { name: 'eclass courseresource', ok: true, detail: result.reason ?? 'skipped' };
    }
    return {
      name: 'eclass courseresource',
      ok: true,
      detail: `probe course ${result.course_id}, items: ${result.item_count}`,
    };
  } catch (err) {
    const message = formatErrorDetail(err);
    return { name: 'eclass courseresource', ok: false, detail: message };
  }
}

export async function credentialBackendCheck(username: string): Promise<CheckResult> {
  const diag = await describeCredentialEnvironment();
  const found = (await getCredential(KEYCHAIN_SERVICE, username)) !== null;
  const base =
    `backend=${diag.backend} (${diag.reason}), keytar=${diag.keytarLoaded ? 'loaded' : 'unavailable'}` +
    `${diag.keytarError ? `(${diag.keytarError})` : ''}, masterKey=${diag.masterKeyPresent ? 'yes' : 'no'}` +
    `, dbus=${diag.dbusSession ? 'yes' : 'no'}`;
  return found
    ? { name: 'credential backend', ok: true, detail: `${base}, credential: found` }
    : { name: 'credential backend', ok: false, detail: `${base}, credential: not found for ${username}` };
}

export type DoctorOptions = {
  hermesConfigPath?: string;
  mcpJsonPath?: string;
  envPassword?: string;
  plaintextOverride?: string;
};

type DoctorCredentials = {
  username?: string;
  envPassword?: string;
  plaintextOverride?: string;
  source: 'env' | 'hermes' | 'mcp-json' | 'missing';
};

export async function resolveDoctorCredentials(
  explicitUsername?: string,
  options: DoctorOptions = {},
): Promise<DoctorCredentials> {
  const trimmed = explicitUsername?.trim();
  if (trimmed) {
    return {
      username: trimmed,
      envPassword: options.envPassword ?? process.env.ECLASS_PASSWORD,
      plaintextOverride: options.plaintextOverride ?? process.env.ALLOW_PLAINTEXT_ENV_SECRETS,
      source: 'env',
    };
  }

  const envUsername = process.env.ECLASS_USERNAME?.trim();
  if (envUsername) {
    return {
      username: envUsername,
      envPassword: process.env.ECLASS_PASSWORD,
      plaintextOverride: process.env.ALLOW_PLAINTEXT_ENV_SECRETS,
      source: 'env',
    };
  }

  const hermesEnv = await readHermesCredentialEnv(options.hermesConfigPath ?? defaultHermesConfigPath());
  if (hermesEnv?.username) {
    return {
      username: hermesEnv.username,
      envPassword: hermesEnv.password,
      plaintextOverride: hermesEnv.plaintextOverride,
      source: 'hermes',
    };
  }

  const mcpJsonPath = options.mcpJsonPath ?? defaultMcpJsonPath(path.resolve(__dirname, '..'));
  const mcpJsonEnv = await readMcpJsonCredentialEnv(mcpJsonPath);
  if (mcpJsonEnv?.username) {
    return {
      username: mcpJsonEnv.username,
      envPassword: mcpJsonEnv.password,
      plaintextOverride: mcpJsonEnv.plaintextOverride,
      source: 'mcp-json',
    };
  }

  return { source: 'missing' };
}

export async function runDoctor(
  username: string | undefined = process.env.ECLASS_USERNAME,
  options: DoctorOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const credentials = await resolveDoctorCredentials(username, options);
  const resolvedUsername = credentials.username;
  results.push(await checkPlaywright());

  if (!resolvedUsername) {
    const detail = 'ECLASS_USERNAME이 설정되지 않았습니다. Hermes 사용자는 ' +
      '`pnpm run setup -- --target hermes --username <id> --password-stdin`를 실행하세요. ' +
      '기존 .mcp.json 사용자는 `pnpm run setup -- --target mcp-json`를 실행하세요.';
    results.push({
      name: 'eclass Playwright',
      ok: false,
      detail,
    });
    results.push({
      name: 'eclass auth',
      ok: false,
      detail,
    });
    results.push({
      name: 'eclass courses API',
      ok: false,
      detail,
    });
    results.push({
      name: 'eclass courseresource',
      ok: false,
      detail,
    });
    return results;
  }

  results.push(await credentialBackendCheck(resolvedUsername));

  const credentialFactory = (): Promise<string> => getEclassPassword(
    resolvedUsername,
    credentials.envPassword,
    undefined,
    credentials.plaintextOverride,
  );
  const session = new BrowserSession(resolvedUsername, credentialFactory);

  const eclassPlaywright = await checkEclassPlaywright(session);
  results.push(eclassPlaywright);
  if (!eclassPlaywright.ok) {
    results.push({ name: 'eclass auth', ok: false, detail: 'Playwright 단계 실패로 건너뜀' });
    results.push({ name: 'eclass courses API', ok: false, detail: 'Playwright 단계 실패로 건너뜀' });
    results.push({ name: 'eclass courseresource', ok: false, detail: 'Playwright 단계 실패로 건너뜀' });
    return results;
  }

  const auth = await checkEclassAuth(session);
  results.push(auth);
  if (!auth.ok) {
    results.push({ name: 'eclass courses API', ok: false, detail: 'auth 단계 실패로 건너뜀' });
    results.push({ name: 'eclass courseresource', ok: false, detail: 'auth 단계 실패로 건너뜀' });
    return results;
  }

  const courses = await checkEclassCoursesApi(session);
  results.push(courses);
  if (!courses.ok) {
    results.push({ name: 'eclass courseresource', ok: false, detail: 'courses API 단계 실패로 건너뜀' });
    return results;
  }

  results.push(await checkEclassCourseresource(session));
  return results;
}
