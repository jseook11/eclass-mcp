import { chromium } from 'playwright';
import type { BrowserContext, Frame, Page, Request, Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CachedToken, CachedTokenRevocation, CachedTokenV2, ResourceItem } from './types.js';
import { CanvasClient } from './canvas-client.js';
import {
  CANVAS_BASE_URL,
  CANVAS_JSON_ACCEPT,
  CANVAS_TOKEN_LIFETIME_MS,
  canAdoptCachedToken,
  createCanvasTokenPurpose,
  createCachedTokenV2,
  extractCreatedCanvasTokenCandidate,
  isCachedTokenV2,
  parseCachedTokenCredential,
  pendingRevocationsForRotation,
  revokeCanvasToken,
  revocationForCreatedCanvasTokenCompensation,
  revocationIdentifier,
  sameCachedTokenGeneration,
  sameCachedTokenSnapshot,
  selectCanvasTokenForRecovery,
} from './canvas-token-lifecycle.js';
import { withCanvasTokenLock } from './canvas-token-lock.js';
import type { CanvasTokenLock } from './canvas-token-lock.js';
import { CanvasTokenRevocationLedger } from './canvas-token-revocation-ledger.js';
import { deleteCredential, getCredential, setCredential } from './credential-store.js';
import { redactUrl } from './discovery/redact.js';
import { debugLog } from './secrets.js';
import { fetchCourseResourceViaApi } from './learningx-client.js';
import { parseModulebuilderItems, parseResourceItems } from './resource-items.js';
import { sanitizeFileName } from './utils.js';

const BASE_URL = CANVAS_BASE_URL;
const KEYCHAIN_SERVICE = 'eclass-mcp';

// Allowlist of origins that may receive credentials (cookies or Bearer token)
const CREDENTIAL_ALLOWED_ORIGINS = new Set([
  'https://eclass3.cau.ac.kr',
  'https://ocs.cau.ac.kr',
  'https://mportal2.cau.ac.kr',
  'https://rpt80.cau.ac.kr',
]);

function assertAllowedOrigin(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[browser-session] ${label} rejected: invalid URL`);
  }
  if (!CREDENTIAL_ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error(`[browser-session] ${label} rejected: origin not in allowlist`);
  }
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

async function readTokenFromKeychain(username: string): Promise<CachedToken | null> {
  const raw = await getCredential(KEYCHAIN_SERVICE, `token:${username}`);
  return parseCachedTokenCredential(raw);
}

async function writeTokenToKeychain(username: string, cached: CachedToken): Promise<void> {
  await setCredential(
    KEYCHAIN_SERVICE,
    `token:${username}`,
    JSON.stringify(cached),
    { allowFileFallback: false },
  );
}

export function parseCachedSessionCredential(raw: string | null): object | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('cookies' in parsed) ||
      !Array.isArray(parsed.cookies) ||
      !('origins' in parsed) ||
      !Array.isArray(parsed.origins)
    ) {
      throw new Error('invalid session cache shape');
    }
    return parsed;
  } catch {
    // The credential backend succeeded, so this is isolated cache corruption,
    // not an unavailable secure store. A fresh login may safely replace it.
    debugLog('browser-session', 'Cached browser session is corrupt; ignoring it');
    return null;
  }
}

async function readSessionFromKeychain(username: string): Promise<object | null> {
  const raw = await getCredential(KEYCHAIN_SERVICE, `session:${username}`);
  return parseCachedSessionCredential(raw);
}

async function writeSessionToKeychain(username: string, state: object): Promise<void> {
  await setCredential(
    KEYCHAIN_SERVICE,
    `session:${username}`,
    JSON.stringify(state),
    { allowFileFallback: false },
  );
}

async function deleteSessionFromKeychain(username: string): Promise<void> {
  try {
    await deleteCredential(KEYCHAIN_SERVICE, `session:${username}`);
  } catch {
    // ignore — not present is fine
  }
}

interface BrowserTokenCreationResponse {
  ok: boolean;
  status: number;
  responseUrl: string;
  body: unknown;
  bodyParsed: boolean;
}

interface BrowserTokenListResponse {
  ok: boolean;
  status: number;
  responseUrl: string;
  body: unknown;
}

class CanvasTokenCacheChangedError extends Error {
  constructor(readonly latest: CachedToken | null) {
    super('Canvas token cache changed during rotation');
  }
}

export function buildCanvasTokenCompensationRetentionError(
  operationError: unknown,
  ledgerError: unknown,
): Error {
  return new Error(
    'A newly issued Canvas token could not be revoked or recorded because secure ' +
    'credential storage failed. The token may still be live; manually revoke the ' +
    'eclass-mcp token in Canvas profile settings before retrying.',
    {
      cause: new AggregateError(
        [operationError, ledgerError],
        'Token operation and ledger append both failed',
      ),
    },
  );
}

export function buildCanvasTokenRecoveryManualCleanupError(
  operationError: unknown,
  recoveryError: unknown,
): Error {
  return new Error(
    'Canvas token creation may have succeeded, but the exact issued token could not be ' +
    'identified and revoked safely. Manually review Canvas profile settings and revoke ' +
    'the correlated eclass-mcp token before retrying.',
    {
      cause: new AggregateError(
        [operationError, recoveryError],
        'Token creation and exact recovery both failed',
      ),
    },
  );
}

function isSameOriginCanvasResponse(responseUrl: string): boolean {
  if (!responseUrl) return false;
  try {
    return new URL(responseUrl).origin === BASE_URL;
  } catch {
    return false;
  }
}

async function createCanvasTokenFromAuthenticatedPage(
  page: Page,
  requestedExpiresAt: string,
  purpose: string,
): Promise<BrowserTokenCreationResponse> {
  if (new URL(page.url()).origin !== BASE_URL) {
    throw new Error('Canvas token creation requires an authenticated same-origin page');
  }

  return page.evaluate(async ({ baseUrl, expiresAt, tokenPurpose, acceptHeader }) => {
    if (window.location.origin !== baseUrl) {
      throw new Error('Canvas token creation page changed origin');
    }
    const csrfToken = (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content;
    const headers: Record<string, string> = {
      Accept: acceptHeader,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    };
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    const form = new URLSearchParams();
    form.set('token[purpose]', tokenPurpose);
    form.set('token[expires_at]', expiresAt);
    const response = await fetch('/api/v1/users/self/tokens', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers,
      body: form.toString(),
    });
    const text = await response.text();
    let body: unknown = null;
    let bodyParsed = false;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
        bodyParsed = true;
      } catch {
        body = null;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      responseUrl: response.url,
      body,
      bodyParsed,
    };
  }, {
    baseUrl: BASE_URL,
    expiresAt: requestedExpiresAt,
    tokenPurpose: purpose,
    acceptHeader: CANVAS_JSON_ACCEPT,
  });
}

export async function listCanvasTokensFromAuthenticatedPage(page: Page): Promise<unknown> {
  if (new URL(page.url()).origin !== BASE_URL) {
    throw new Error('Canvas token recovery requires an authenticated same-origin page');
  }
  const result: BrowserTokenListResponse = await page.evaluate(
    async ({ baseUrl, acceptHeader }) => {
      if (window.location.origin !== baseUrl) {
        throw new Error('Canvas token recovery page changed origin');
      }
      const response = await fetch(
        '/api/v1/users/self/user_generated_tokens?per_page=100',
        {
          method: 'GET',
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { Accept: acceptHeader },
        },
      );
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        responseUrl: response.url,
        body: text ? JSON.parse(text) as unknown : null,
      };
    },
    { baseUrl: BASE_URL, acceptHeader: CANVAS_JSON_ACCEPT },
  );
  if (!isSameOriginCanvasResponse(result.responseUrl)) {
    throw new Error('Canvas token recovery response came from an unexpected origin');
  }
  if (!result.ok) {
    throw new Error(`Canvas token recovery listing failed (${result.status})`);
  }
  return result.body;
}

export async function revokeCanvasTokenFromAuthenticatedPage(
  page: Page,
  revocation: CachedTokenRevocation,
): Promise<boolean> {
  const identifier = revocationIdentifier(revocation);
  if (!identifier) return false;

  try {
    if (new URL(page.url()).origin !== BASE_URL) return false;
    const result = await page.evaluate(async ({ baseUrl, tokenIdentifier, acceptHeader }) => {
      if (window.location.origin !== baseUrl) return { status: 0, responseUrl: '' };
      const csrfToken = (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content;
      const headers: Record<string, string> = { Accept: acceptHeader };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      const response = await fetch(
        `/api/v1/users/self/tokens/${encodeURIComponent(tokenIdentifier)}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers,
        },
      );
      return { status: response.status, responseUrl: response.url };
    }, {
      baseUrl: BASE_URL,
      tokenIdentifier: identifier,
      acceptHeader: CANVAS_JSON_ACCEPT,
    });
    if (!result.responseUrl || new URL(result.responseUrl).origin !== BASE_URL) return false;
    return (result.status >= 200 && result.status < 300) || result.status === 404;
  } catch {
    return false;
  }
}

export function isSsoLoginUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === 'canvas.cau.ac.kr' && url.pathname.startsWith('/xn-sso/')) ||
      (url.hostname === 'eclass3.cau.ac.kr' && url.pathname === '/login') ||
      (url.hostname === 'mportal2.cau.ac.kr' &&
        url.pathname === '/common/auth/newSsoLogin.do')
    );
  } catch {
    return false;
  }
}

export interface EclassAuthProbeResult {
  token_source: 'cache' | 'login';
}

export interface EclassCoursesProbeResult {
  course_count: number;
}

export interface EclassCourseresourceProbeResult {
  course_id: number | null;
  item_count: number;
  skipped: boolean;
  reason?: string;
}

export interface OcsCaptureFailureDetails {
  resourceId: string;
  displayName: string;
  finalPageUrl: string;
  pageTitle: string;
  recentFrames: string[];
  recentRequests: string[];
  recentResponses: string[];
  mediaCandidates: string[];
  videoSources: string[];
  iframeSources: string[];
}

type SessionContextOptions = {
  acceptDownloads?: boolean;
};

function normalizeCourseId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function trackRecent(entries: string[], value: string, limit = 12): void {
  entries.push(value);
  if (entries.length > limit) entries.shift();
}

const DIAGNOSTIC_URL_PATTERN = /(?:https?|blob:https?):\/\/[^\s|]+/gi;
const DIAGNOSTIC_SECRET_QUERY_PATTERN = /([?&#](?:[^=&#]*(?:token|secret|password|session|cookie|auth|signature|sig|verifier|ticket|sso|saml|assertion|relay|oauth|code|state|jwt|key)[^=&#]*)=)[^&\s|]*/gi;

export function redactBrowserDiagnostic(value: string): string {
  return value
    .replace(DIAGNOSTIC_URL_PATTERN, (url) => redactUrl(url))
    .replace(DIAGNOSTIC_SECRET_QUERY_PATTERN, '$1[REDACTED]');
}

function redactBrowserUrl(rawUrl: string, baseUrl?: string): string {
  if (baseUrl) {
    try {
      return redactUrl(new URL(rawUrl, baseUrl).toString());
    } catch {
      // Fall through to the fail-closed unparseable marker.
    }
  }
  return redactUrl(rawUrl);
}

function sessionRedirectError(rawUrl: string): Error {
  return new Error(`SESSION_REDIRECT:${redactBrowserUrl(rawUrl)}`);
}

function summarizeRecent(entries: string[]): string {
  return entries.length > 0 ? entries.map(redactBrowserDiagnostic).join(' | ') : 'none';
}

function isTrackedBrowserUrl(url: string): boolean {
  return url.includes('eclass3.cau.ac.kr') || url.includes('ocs.cau.ac.kr') || url.includes('canvas.cau.ac.kr');
}

function matchesLikelyMediaUrl(url: string): boolean {
  return /\.(m3u8|mp4|m4v|ts|mp3|wav)(?:$|[?#])/i.test(url) || /\/(media|stream|download)\//i.test(url);
}

export function isStreamingMediaType(type: string | null | undefined): boolean {
  const normalized = type?.trim().toLowerCase();
  if (!normalized) return false;
  return [
    'mp4',
    'm4v',
    'mov',
    'avi',
    'wmv',
    'video',
    'movie',
    'media',
    'hls',
    'm3u8',
    'stream',
    'audio',
    'mp3',
    'wav',
  ].includes(normalized) || normalized.startsWith('video/');
}

function isDownloadableResponse(response: Response): boolean {
  const url = response.url();
  const headers = response.headers();
  const contentType = (headers['content-type'] ?? '').toLowerCase();
  const contentDisposition = (headers['content-disposition'] ?? '').toLowerCase();

  if (response.status() !== 200) return false;
  if (contentDisposition.includes('attachment')) return true;
  if (contentType.includes('application/pdf')) return true;
  if (contentType.includes('application/octet-stream')) return true;
  if (contentType.includes('application/zip')) return true;
  if (/\.(pdf|zip|doc|docx|ppt|pptx|xls|xlsx|hwp)(?:$|[?#])/i.test(url)) return true;
  return false;
}

export function buildOcsCaptureFailureMessage(details: OcsCaptureFailureDetails): string {
  const finalPage = details.finalPageUrl ? redactBrowserUrl(details.finalPageUrl) : '(unknown)';
  const title = details.pageTitle || '(unknown)';
  const recentFrames = summarizeRecent(details.recentFrames);
  const recentRequests = summarizeRecent(details.recentRequests);
  const recentResponses = summarizeRecent(details.recentResponses);
  const mediaCandidates = summarizeRecent(details.mediaCandidates);
  const videoSources = summarizeRecent(
    details.videoSources.map((url) => redactBrowserUrl(url, details.finalPageUrl)),
  );
  const iframeSources = summarizeRecent(
    details.iframeSources.map((url) => redactBrowserUrl(url, details.finalPageUrl)),
  );

  return (
    'OCS viewer loaded but no downloadable file response was captured.\n' +
    `  resource_id: ${details.resourceId}\n` +
    `  display_name: ${details.displayName}\n` +
    `  final page: ${finalPage}\n` +
    `  page title: ${title}\n` +
    `  recent frames: ${recentFrames}\n` +
    `  recent requests: ${recentRequests}\n` +
    `  recent responses: ${recentResponses}\n` +
    `  media candidates: ${mediaCandidates}\n` +
    `  video sources: ${videoSources}\n` +
    `  iframe sources: ${iframeSources}`
  );
}

export class BrowserSession {
  private client: CanvasClient | null = null;
  // Single-flight lock: prevents parallel callers from each launching a browser login
  private loginPromise: Promise<CanvasClient> | null = null;
  private playwrightCheckPromise: Promise<void> | null = null;
  private lastPlaywrightCheckAt = 0;
  private lastAuthSource: 'cache' | 'login' | null = null;
  // Single-flight lock for 401-triggered token refresh
  private tokenRefreshPromise: Promise<string> | null = null;
  // Injectable for tests: courseresource API-first fetch before Playwright fallback
  private courseResourceApiFetcher: typeof fetchCourseResourceViaApi = fetchCourseResourceViaApi;

  /**
   * @param credentialFactory - called only at login time; result goes out of scope
   *   after the Playwright fill call, narrowing the heap exposure window to ~20s.
   */
  constructor(
    private username: string,
    private credentialFactory: () => Promise<string>,
  ) {}

  /**
   * Returns a CanvasClient with a valid token.
   * Reads token cache first; if missing or expired, launches a headless browser
   * to log in and issue a new Canvas API token.
   * Concurrent calls share a single login attempt via loginPromise.
   */
  async getClient(): Promise<CanvasClient> {
    if (this.client) return this.client;
    return this.startLogin();
  }

  private startLogin(rejectedToken?: string): Promise<CanvasClient> {
    if (!this.loginPromise) {
      this.loginPromise = this._doLogin(rejectedToken).catch((err: unknown) => {
        this.loginPromise = null; // allow retry on failure
        throw err;
      });
    }
    return this.loginPromise;
  }

  async ensurePlaywrightReady(): Promise<void> {
    const now = Date.now();
    if (this.lastPlaywrightCheckAt !== 0 && now - this.lastPlaywrightCheckAt < 5 * 60 * 1000) {
      return;
    }

    if (!this.playwrightCheckPromise) {
      this.playwrightCheckPromise = (async () => {
        let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
        try {
          browser = await chromium.launch({ headless: true });
          this.lastPlaywrightCheckAt = Date.now();
          debugLog('browser-session', `Playwright health check passed (${browser.version() || 'chromium'})`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            'Playwright Chromium 검차 실패: 브라우저를 실행할 수 없습니다.\n' +
            `  원인: ${message}\n` +
            '  해결: pnpm run install:browser',
          );
        } finally {
          await browser?.close().catch(() => undefined);
          this.playwrightCheckPromise = null;
        }
      })();
    }

    return this.playwrightCheckPromise;
  }

  async ensureAuthenticated(): Promise<EclassAuthProbeResult> {
    await this.getClient();
    return {
      token_source: this.lastAuthSource ?? 'login',
    };
  }

  async probeCoursesApi(): Promise<EclassCoursesProbeResult> {
    const client = await this.getClient();
    const response = await client.fetchOne<Array<{ id?: number }>>('/api/v1/courses?enrollment_state=active&per_page=1');
    return {
      course_count: Array.isArray(response) ? response.length : 0,
    };
  }

  async probeCourseresource(): Promise<EclassCourseresourceProbeResult> {
    const client = await this.getClient();
    const courses = await client.fetchOne<Array<{ id: string | number; name?: string }>>('/api/v1/courses?enrollment_state=active&per_page=1');
    const firstCourseId = Array.isArray(courses)
      ? courses.map((course) => normalizeCourseId(course.id)).find((courseId) => courseId !== null) ?? null
      : null;
    if (firstCourseId === null) {
      return {
        course_id: null,
        item_count: 0,
        skipped: true,
        reason: '활성 강의가 없어 courseresource 검차를 건너뜁니다.',
      };
    }

    const items = await this.interceptCourseresource(firstCourseId);
    return {
      course_id: firstCourseId,
      item_count: items.length,
      skipped: false,
    };
  }

  private createCanvasClient(token: string): CanvasClient {
    return new CanvasClient(
      BASE_URL,
      token,
      (rejectedToken) => this.refreshTokenAfterAuthError(rejectedToken),
    );
  }

  /** Called by CanvasClient after a 401. The rejected token is carried into the
   * interprocess critical section so a newer token from another process can be
   * adopted instead of rotated away. */
  private async refreshTokenAfterAuthError(rejectedToken: string): Promise<string> {
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = (async () => {
        try {
          debugLog('browser-session', 'Canvas returned 401; reconciling the shared token cache');
          this.client = null;
          this.loginPromise = null;
          const client = await this.startLogin(rejectedToken);
          return client.getToken();
        } finally {
          this.tokenRefreshPromise = null;
        }
      })();
    }
    return this.tokenRefreshPromise;
  }

  private async retryPendingTokenRevocations(
    cached: CachedTokenV2,
    ledger: CanvasTokenRevocationLedger,
    lock: CanvasTokenLock,
  ): Promise<CachedTokenV2> {
    await lock.assertOwned();
    // Merge the independent ledger with the legacy embedded queue, excluding
    // both the active id and its hint. The ledger is durably updated before the
    // embedded queue is compacted, so crashes can only cause safe duplicate
    // retries (successful deletion is subsequently observed as 404).
    await ledger.retry(lock, cached, cached.pending_revocations);
    const updated: CachedTokenV2 = { ...cached, pending_revocations: [] };

    if (cached.pending_revocations.length > 0) {
      await lock.assertOwned();
      const current = await readTokenFromKeychain(this.username);
      if (!sameCachedTokenSnapshot(current, cached)) {
        debugLog('browser-session', 'Skipped stale Canvas token revocation queue compaction');
        return current && isCachedTokenV2(current) ? current : cached;
      }
      try {
        await writeTokenToKeychain(this.username, updated);
      } catch {
        // The already-persisted queue is a safe superset and will be retried on
        // the next startup. Never fall back to plaintext just to compact it.
        debugLog('browser-session', 'Could not persist the compacted Canvas token revocation queue');
      }
    }
    return updated;
  }

  private async _doLogin(rejectedToken?: string): Promise<CanvasClient> {
    return withCanvasTokenLock(
      this.username,
      (lock) => this._doLoginWithTokenLock(lock, rejectedToken),
    );
  }

  private async _doLoginWithTokenLock(
    lock: CanvasTokenLock,
    rejectedToken?: string,
  ): Promise<CanvasClient> {
    await lock.assertOwned();
    const revocationLedger = new CanvasTokenRevocationLedger(this.username);
    // Only V2 caches are reusable. Legacy V1 caches must rotate so their old
    // token can be represented by its deterministic five-character hint.
    let cached = await readTokenFromKeychain(this.username);
    // Fail closed on ledger backend/schema errors before issuing another token.
    await revocationLedger.read(lock);
    if (cached && canAdoptCachedToken(cached, rejectedToken)) {
      debugLog(
        'browser-session',
        rejectedToken === undefined
          ? 'Using cached token'
          : 'Adopting a newer Canvas token issued by another process',
      );
      const usableCached = await this.retryPendingTokenRevocations(
        cached,
        revocationLedger,
        lock,
      );
      if (canAdoptCachedToken(usableCached, rejectedToken)) {
        this.lastAuthSource = 'cache';
        this.client = this.createCanvasClient(usableCached.token);
        return this.client;
      }
      cached = usableCached;
    }

    // Need to log in and issue a new token
    debugLog('browser-session', 'Launching browser for login');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
      });
      const page = await context.newPage();
      await this.loginToEclass(page);

      // Establish a same-origin authenticated page, then call Canvas's token API
      // with that page's cookies and CSRF token. The secret never enters the DOM.
      debugLog('browser-session', 'Creating a 90-day Canvas API token from an authenticated page');
      await page.goto(`${BASE_URL}/profile/settings`, { waitUntil: 'networkidle', timeout: 15000 });
      if (isSsoLoginUrl(page.url())) {
        throw new Error('로그인 세션이 프로필 설정 페이지로 이동하기 전에 만료되었습니다.');
      }
      const requestStartedAt = new Date().toISOString();
      const requestedExpiresAt = new Date(
        Date.parse(requestStartedAt) + CANVAS_TOKEN_LIFETIME_MS,
      ).toISOString();
      const purpose = createCanvasTokenPurpose();
      let creation: BrowserTokenCreationResponse | null = null;
      let creationCallError: unknown = null;
      try {
        creation = await createCanvasTokenFromAuthenticatedPage(
          page,
          requestedExpiresAt,
          purpose,
        );
      } catch (err) {
        // The POST may have committed before fetch/response transport failed.
        // Compensation below reconciles by this attempt's unique purpose.
        creationCallError = err;
      }
      const candidate = creation
        ? extractCreatedCanvasTokenCandidate(creation.body)
        : null;
      let persisted = false;

      try {
        if (!creation) {
          throw new Error('Canvas token creation response was not received', {
            cause: creationCallError,
          });
        }
        if (!isSameOriginCanvasResponse(creation.responseUrl)) {
          throw new Error('Canvas token creation response came from an unexpected origin');
        }
        if (!creation.ok) {
          throw new Error(`Canvas token creation failed (${creation.status})`);
        }
        if (!candidate) {
          throw new Error('Canvas token creation response did not include a visible token');
        }

        let newCached = createCachedTokenV2(candidate, requestStartedAt, requestedExpiresAt);

        // Validate before persisting. Any failure below is compensated by
        // revoking the newly-created token while the browser session is alive.
        const validateRes = await fetch(`${BASE_URL}/api/v1/users/self`, {
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${newCached.token}`, Accept: CANVAS_JSON_ACCEPT },
        });
        if (!validateRes.ok) {
          throw new Error(
            `토큰 검증 실패 (${validateRes.status}): 로그인에 문제가 있습니다.\n` +
            '  pnpm run setup 을 다시 실행하세요.',
          );
        }

        await lock.assertOwned();
        const latestCached = await readTokenFromKeychain(this.username);
        if (!sameCachedTokenGeneration(cached, latestCached)) {
          throw new CanvasTokenCacheChangedError(latestCached);
        }
        // A same-generation queue may have been compacted by a process that did
        // not yet implement the lock. Merge from the latest snapshot.
        newCached = {
          ...newCached,
          pending_revocations: pendingRevocationsForRotation(latestCached, newCached),
        };

        // Persist the new token (including the old-token revocation queue)
        // before attempting any old-token deletion. A crash can only leave a
        // retryable queue, never lose the metadata required to revoke it.
        const sessionState = await context.storageState();
        await writeSessionToKeychain(this.username, sessionState);
        await lock.assertOwned();
        const beforeTokenWrite = await readTokenFromKeychain(this.username);
        if (!sameCachedTokenSnapshot(latestCached, beforeTokenWrite)) {
          throw new CanvasTokenCacheChangedError(beforeTokenWrite);
        }
        try {
          await writeTokenToKeychain(this.username, newCached);
          persisted = true;
        } catch (err) {
          // Do not revoke a token that the backend durably stored before
          // reporting a post-write verification/cleanup error.
          const observed = await readTokenFromKeychain(this.username);
          persisted = sameCachedTokenSnapshot(observed, newCached);
          throw err;
        }
        debugLog('browser-session', 'New Canvas token and revocation metadata stored securely');

        newCached = await this.retryPendingTokenRevocations(
          newCached,
          revocationLedger,
          lock,
        );
        this.lastAuthSource = 'login';
        this.client = this.createCanvasClient(newCached.token);
        return this.client;
      } catch (err) {
        let unresolvedCreatedRevocation: CachedTokenRevocation | null = null;
        let compensationRevocation = creation
          ? revocationForCreatedCanvasTokenCompensation(creation, persisted)
          : null;
        const requiresExactRecovery = !persisted &&
          !compensationRevocation &&
          (
            creation === null ||
            !isSameOriginCanvasResponse(creation.responseUrl) ||
            !creation.bodyParsed ||
            creation.ok
          );
        if (requiresExactRecovery) {
          try {
            const listedTokens = await listCanvasTokensFromAuthenticatedPage(page);
            const selection = selectCanvasTokenForRecovery(listedTokens, {
              purpose,
              request_started_at: requestStartedAt,
              requested_expires_at: requestedExpiresAt,
              observed_at: new Date().toISOString(),
            });
            if (selection.kind !== 'found') {
              throw new Error(`Exact Canvas token recovery result: ${selection.kind}`);
            }
            compensationRevocation = selection.revocation;
          } catch (recoveryErr) {
            throw buildCanvasTokenRecoveryManualCleanupError(err, recoveryErr);
          }
        }
        if (compensationRevocation) {
          let revoked = await revokeCanvasTokenFromAuthenticatedPage(page, compensationRevocation);
          if (
            !revoked &&
            candidate &&
            creation &&
            isSameOriginCanvasResponse(creation.responseUrl)
          ) {
            revoked = await revokeCanvasToken(
              candidate.token,
              compensationRevocation,
            );
          }
          if (!revoked) {
            debugLog('browser-session', 'Could not compensate by revoking the newly-created Canvas token');
            unresolvedCreatedRevocation = compensationRevocation;
          }
        }
        if (unresolvedCreatedRevocation) {
          const activeForSafety = err instanceof CanvasTokenCacheChangedError
            ? err.latest
            : cached;
          try {
            await revocationLedger.append(lock, unresolvedCreatedRevocation, activeForSafety);
          } catch (ledgerErr) {
            throw buildCanvasTokenCompensationRetentionError(err, ledgerErr);
          }
          debugLog('browser-session', 'Retained failed Canvas token compensation in the secure ledger');
        }
        const latest = err instanceof CanvasTokenCacheChangedError
          ? err.latest
          : await readTokenFromKeychain(this.username);
        if (err instanceof CanvasTokenCacheChangedError && latest) {
          if (!canAdoptCachedToken(latest, rejectedToken)) throw err;
          debugLog('browser-session', 'Adopting Canvas token that won a concurrent cache update');
          const adopted = await this.retryPendingTokenRevocations(
            latest,
            revocationLedger,
            lock,
          );
          if (canAdoptCachedToken(adopted, rejectedToken)) {
            this.lastAuthSource = 'cache';
            this.client = this.createCanvasClient(adopted.token);
            return this.client;
          }
        }
        throw err;
      }
    } finally {
      await browser.close();
    }
  }

  private async loginToEclass(page: Page): Promise<void> {
    // Navigate to login page
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Fill in credentials — password is read from factory and goes out of scope immediately
    const password = await this.credentialFactory();
    await page.locator("input[name='login_user_id']").fill(this.username);
    await page.locator("input[name='login_user_password']").fill(password);

    // Trigger login via JS and wait for navigation
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }),
      page.evaluate('OnLogon()'),
    ]);

    const parsedLoginUrl = new URL(page.url());
    if (parsedLoginUrl.hostname !== 'eclass3.cau.ac.kr' || isSsoLoginUrl(page.url())) {
      throw new Error(
        '로그인 실패: 아이디 또는 비밀번호가 올바르지 않습니다.\n' +
        '  pnpm run setup 을 다시 실행하여 비밀번호를 업데이트하세요.',
      );
    }
    debugLog('browser-session', 'Login successful');
  }

  private async refreshBrowserSession(lock: CanvasTokenLock): Promise<void> {
    debugLog('browser-session', 'Refreshing browser session via login');
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
      });
      const page = await context.newPage();
      await this.loginToEclass(page);
      const sessionState = await context.storageState();
      await lock.assertOwned();
      await writeSessionToKeychain(this.username, sessionState);
      debugLog('browser-session', 'Browser session refreshed in Keychain');
    } finally {
      await browser.close();
    }
  }

  private async withAuthenticatedContext<T>(
    label: string,
    options: SessionContextOptions,
    fn: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cachedSessionState: any = await readSessionFromKeychain(this.username) ?? undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          locale: 'ko-KR',
          timezoneId: 'Asia/Seoul',
          ...(options.acceptDownloads ? { acceptDownloads: true } : {}),
          ...(cachedSessionState ? { storageState: cachedSessionState } : {}),
        });

        try {
          return await fn(context);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === 0 && message.startsWith('SESSION_REDIRECT:')) {
            const redirectedUrl = message.slice('SESSION_REDIRECT:'.length);
            debugLog(
              'browser-session',
              `${label} redirected to login, refreshing session: ${redactBrowserUrl(redirectedUrl)}`,
            );
            await withCanvasTokenLock(this.username, async (lock) => {
              await lock.assertOwned();
              await deleteSessionFromKeychain(this.username);
              await this.refreshBrowserSession(lock);
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cachedSessionState = await readSessionFromKeychain(this.username) ?? undefined;
            continue;
          }
          throw err;
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }

    throw new Error(`${label} 세션 재시도 후에도 브라우저 인증을 복구하지 못했습니다.`);
  }

  /**
   * Runs fn inside an authenticated browser context for endpoint discovery
   * (src/discovery/, scripts/discover.ts). Session refresh and origin rules
   * are identical to the other Playwright flows.
   */
  async withDiscoveryContext<T>(
    label: string,
    fn: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    await this.ensurePlaywrightReady();
    await this.getClient();
    return this.withAuthenticatedContext(label, {}, fn);
  }

  /**
   * mportal2 ajax POST (JSON). 인증 컨텍스트의 세션 쿠키 사용.
   *
   * mportal2 ajax는 SSO 세션(JSESSIONID)이 컨텍스트에 확립돼 있어야 JSON을 준다.
   * 캐시된 eclass storageState에는 `ssotoken`만 있고 mportal2 JSESSIONID는 없으므로,
   * POST 전에 mportal2 포털 페이지를 1회 navigate해 SSO interlock가 자동 로그인하며
   * JSESSIONID를 세팅하게 한다(미실시 시 ajax가 HTML 로그인 페이지를 반환해 JSON 파싱 실패).
   * eclass 세션 만료로 실제 로그인 페이지로 튕기면 SESSION_REDIRECT로 재로그인 후 1회 재시도.
   */
  async mportalPostJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    await this.ensurePlaywrightReady();
    await this.getClient();
    const url = `https://mportal2.cau.ac.kr${path}`;
    const warmupUrl = 'https://mportal2.cau.ac.kr/std/usk/sUskSif002/index.do?type=1';
    assertAllowedOrigin(url, 'mportalPostJson');
    return this.withAuthenticatedContext('mportal post', {}, async (context) => {
      const page = await context.newPage();
      try {
        await page.goto(warmupUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(page.url())) {
          throw sessionRedirectError(page.url());
        }
      } finally {
        await page.close();
      }
      const res = await context.request.post(url, {
        data: body,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok()) throw new Error(`mportal ${path} failed ${res.status()}`);
      return await res.json() as T;
    });
  }

  /** OZ HTML5 뷰어의 저장 다이얼로그를 열고 PDF export 다운로드를 받아 buffer로 반환. */
  async fetchOzPdf(viewerUrl: string, _postParams: Record<string, string>): Promise<Buffer> {
    await this.ensurePlaywrightReady();
    await this.getClient();
    assertAllowedOrigin(viewerUrl, 'fetchOzPdf');
    const warmupUrl = 'https://mportal2.cau.ac.kr/std/usk/sUskSif002/index.do?type=1';
    return this.withAuthenticatedContext('oz pdf', { acceptDownloads: true }, async (context) => {
      const warmupPage = await context.newPage();
      try {
        await warmupPage.goto(warmupUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(warmupPage.url())) {
          throw sessionRedirectError(warmupPage.url());
        }
      } finally {
        await warmupPage.close();
      }

      const page = await context.newPage();
      try {
        await page.goto(viewerUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(page.url())) {
          throw sessionRedirectError(page.url());
        }
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
          const ozWindow = window as unknown as { getOZMovie?: unknown };
          return Boolean(canvas?.width && canvas.height && typeof ozWindow.getOZMovie === 'function');
        }, { timeout: 30000 });
        await page.waitForTimeout(1500);

        await page.evaluate(`(function () {
          var movie = window.getOZMovie && window.getOZMovie('OZViewer');
          if (!movie || typeof movie.Script !== 'function') {
            throw new Error('OZ viewer Script API unavailable');
          }
          movie.Script('save');
        })()`);

        const dialog = page.locator('.ui-dialog').filter({ hasText: '저장' }).last();
        await dialog.waitFor({ state: 'visible', timeout: 15000 });
        await dialog.locator('select').last().selectOption('Adobe PDF File(*.pdf)');

        const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
        await dialog.getByRole('button', { name: '확인' }).click();
        const download = await downloadPromise;
        const pdfPath = await download.path();
        if (!pdfPath) {
          throw new Error('OZ PDF download did not produce a readable local path');
        }
        const pdf = await fs.readFile(pdfPath);
        if (pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
          throw new Error(`OZ export returned non-PDF download: ${download.suggestedFilename()}`);
        }
        return pdf;
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  async submitAssignmentViaUi(
    courseId: number,
    assignmentId: number,
    filePaths: string[],
    comment?: string,
  ): Promise<void> {
    await this.ensurePlaywrightReady();
    await this.getClient();

    return this.withAuthenticatedContext('assignment submission', {}, async (context) => {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/courses/${courseId}/assignments/${assignmentId}`, { waitUntil: 'networkidle', timeout: 30000 });
      if (isSsoLoginUrl(page.url())) {
          throw sessionRedirectError(page.url());
      }

      const submitLink = page.locator('.submit_assignment_link').first();
      if (await submitLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await submitLink.click();
      }

      const fileInput = page.locator('input[name="attachments[0][uploaded_data]"]').first();
      await fileInput.setInputFiles(filePaths, { timeout: 15000 });

      if (comment?.trim()) {
        const commentBox = page.locator('textarea[name="submission[comment]"]').first();
        if (await commentBox.isVisible({ timeout: 2000 }).catch(() => false)) {
          await commentBox.fill(comment);
        }
      }

      const pledge = page.locator('input[name="turnitin_pledge"]').first();
      if (await pledge.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pledge.check();
      }

      const responsePromise = page.waitForResponse(
        (response: Response) => response.request().method() === 'POST'
          && response.url().includes(`/courses/${courseId}/assignments/${assignmentId}/submissions`),
        { timeout: 30000 },
      );
      // 클릭이 실패하면 responsePromise는 await되지 못한 채 컨텍스트 종료 시
      // TargetClosedError로 reject되어 프로세스를 죽인다 — 미리 핸들러를 붙여둔다.
      responsePromise.catch(() => undefined);
      await page.locator('input[type="submit"][value*="과제 제출"], button:has-text("과제 제출")').first().click();
      const response = await responsePromise;
      if (!response.ok() && ![302, 303].includes(response.status())) {
        throw new Error(`UI submission failed ${response.status()}`);
      }
    });
  }

  /**
   * Downloads a courseresource file using Playwright.
   * If viewUrl (OCS viewer URL) is provided, navigates there and intercepts the file response.
   * Returns the local path where the file was saved.
   */
  async downloadCourseresourceFile(
    courseId: number,
    resourceId: string,
    displayName: string,
    downloadDir: string,
    viewUrl?: string,
  ): Promise<string> {
    await this.ensurePlaywrightReady();
    await this.getClient();

    const safeName = sanitizeFileName(displayName);
    if (!safeName) {
      throw new Error(`[browser-session] Invalid displayName: ${JSON.stringify(displayName)}`);
    }
    const dir = path.join(expandTilde(downloadDir), String(courseId));
    await fs.mkdir(dir, { recursive: true });
    const destPath = path.join(dir, safeName);

    debugLog('browser-session', `Downloading courseresource for course ${courseId}`);

    return this.withAuthenticatedContext('courseresource download', { acceptDownloads: true }, async (context) => {
      if (viewUrl) {
        assertAllowedOrigin(viewUrl, 'viewUrl');
        const page = await context.newPage();
        const recentRequests: string[] = [];
        const recentResponses: string[] = [];
        const recentFrames: string[] = [];
        const mediaCandidates: string[] = [];
        let capturedFileUrl: string | null = null;

        const recordMediaCandidate = (label: string, url: string): void => {
          if (!isTrackedBrowserUrl(url)) return;
          if (!matchesLikelyMediaUrl(url)) return;
          trackRecent(mediaCandidates, `${label} ${redactBrowserUrl(url)}`);
        };

        page.on('request', (request: Request) => {
          const url = request.url();
          if (!isTrackedBrowserUrl(url)) return;
          const resourceType = request.resourceType();
          trackRecent(recentRequests, `${request.method()} ${resourceType} ${redactBrowserUrl(url)}`);
          recordMediaCandidate(`[request:${resourceType}]`, url);
        });
        page.on('response', (response: Response) => {
          const url = response.url();
          if (!isTrackedBrowserUrl(url)) return;
          const resourceType = response.request().resourceType();
          const contentType = response.headers()['content-type'] ?? '';
          trackRecent(recentResponses, `${response.status()} ${resourceType} ${contentType || '(no content-type)'} ${redactBrowserUrl(url)}`);
          recordMediaCandidate(`[response:${resourceType}:${contentType || 'unknown'}]`, url);
          if (capturedFileUrl) return;
          if (isDownloadableResponse(response)) {
            capturedFileUrl = url;
          }
        });
        page.on('framenavigated', (frame: Frame) => {
          const frameUrl = frame.url();
          if (!frameUrl || !isTrackedBrowserUrl(frameUrl)) return;
          trackRecent(recentFrames, redactBrowserUrl(frameUrl));
        });
        context.on('page', (spawnedPage: Page) => {
          spawnedPage.on('request', (request: Request) => {
            const url = request.url();
            if (!isTrackedBrowserUrl(url)) return;
            const resourceType = request.resourceType();
            trackRecent(recentRequests, `${request.method()} ${resourceType} ${redactBrowserUrl(url)}`);
            recordMediaCandidate(`[popup-request:${resourceType}]`, url);
          });
          spawnedPage.on('response', (response: Response) => {
            const url = response.url();
            if (!isTrackedBrowserUrl(url)) return;
            const resourceType = response.request().resourceType();
            const contentType = response.headers()['content-type'] ?? '';
            trackRecent(recentResponses, `${response.status()} ${resourceType} ${contentType || '(no content-type)'} ${redactBrowserUrl(url)}`);
            recordMediaCandidate(`[popup-response:${resourceType}:${contentType || 'unknown'}]`, url);
            if (!capturedFileUrl && isDownloadableResponse(response)) {
              capturedFileUrl = url;
            }
          });
          spawnedPage.on('framenavigated', (frame: Frame) => {
            const frameUrl = frame.url();
            if (!frameUrl || !isTrackedBrowserUrl(frameUrl)) return;
            trackRecent(recentFrames, redactBrowserUrl(frameUrl));
          });
        });

        debugLog('browser-session', 'Navigating to OCS viewer');
        await page.goto(viewUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(page.url())) {
          throw sessionRedirectError(page.url());
        }

        if (!capturedFileUrl) {
          const [pageTitle, domSnapshot] = await Promise.all([
            page.title().catch(() => ''),
            page.evaluate(() => {
              const videoSources = Array.from(document.querySelectorAll('video')).flatMap((video) => {
                const candidates = [
                  video.currentSrc,
                  video.getAttribute('src'),
                  ...Array.from(video.querySelectorAll('source')).map((source) => source.getAttribute('src')),
                ];
                return candidates.filter((value): value is string => Boolean(value && value.trim()));
              });
              const iframeSources = Array.from(document.querySelectorAll('iframe'))
                .map((iframe) => iframe.getAttribute('src'))
                .filter((value): value is string => Boolean(value && value.trim()));
              return {
                videoSources: Array.from(new Set(videoSources)),
                iframeSources: Array.from(new Set(iframeSources)),
              };
            }).catch(() => ({ videoSources: [] as string[], iframeSources: [] as string[] })),
          ]);

          throw new Error(buildOcsCaptureFailureMessage({
            resourceId: resourceId,
            displayName: displayName,
            finalPageUrl: redactBrowserUrl(page.url()),
            pageTitle,
            recentFrames,
            recentRequests,
            recentResponses,
            mediaCandidates,
            videoSources: domSnapshot.videoSources.map((url) => redactBrowserUrl(url, page.url())),
            iframeSources: domSnapshot.iframeSources.map((url) => redactBrowserUrl(url, page.url())),
          }));
        }

        assertAllowedOrigin(capturedFileUrl, 'capturedFileUrl');
        const apiResponse = await context.request.get(capturedFileUrl);
        if (!apiResponse.ok()) {
          throw new Error(`File fetch failed: ${apiResponse.status()}`);
        }
        const buffer = await apiResponse.body();
        await fs.writeFile(destPath, buffer);
        debugLog('browser-session', 'Downloaded via OCS viewer intercept');
        return destPath;
      }

      const page = await context.newPage();
      const ltiUrl = `${BASE_URL}/courses/${courseId}/external_tools/3`;
      await page.goto(ltiUrl, { waitUntil: 'networkidle', timeout: 30000 });
      if (isSsoLoginUrl(page.url())) {
        throw sessionRedirectError(page.url());
      }

      throw new Error(`Resource ${resourceId} has no viewUrl — cannot download without OCS viewer URL`);
    });
  }

  /**
   * Navigates to the modulebuilder LTI page (external_tools/211) and intercepts
   * the modules?include_detail=true API response to extract OCS-backed materials.
   */
  async interceptModulebuilder(courseId: number): Promise<ResourceItem[]> {
    await this.ensurePlaywrightReady();
    debugLog('browser-session', `Intercepting modulebuilder for course ${courseId}`);
    await this.getClient();

    return this.withAuthenticatedContext('modulebuilder', {}, async (context) => {
      const page = await context.newPage();
      const modulesPromise = page.waitForResponse(
        (response: Response) => response.url().includes('/modules?include_detail=true'),
        { timeout: 30000 },
      ).catch((err: unknown) => {
        if (page.isClosed()) return null;
        throw err;
      });

      const ltiUrl = `${BASE_URL}/courses/${courseId}/external_tools/211`;
      await page.goto(ltiUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (isSsoLoginUrl(page.url())) {
        throw sessionRedirectError(page.url());
      }

      const modulesResponse = await modulesPromise;
      if (!modulesResponse) {
        throw new Error('modulebuilder 응답 대기 중 페이지가 닫혔습니다.');
      }
      const body = await modulesResponse.json() as unknown;
      return parseModulebuilderItems(body);
    });
  }

  /**
   * Navigates to the courseresource LTI page for the given course and intercepts
   * the network response that contains the resource list (URL matches 'resources_db').
   */
  async interceptCourseresource(courseId: number): Promise<ResourceItem[]> {
    debugLog('browser-session', `Fetching courseresource for course ${courseId}`);

    const client = await this.getClient();
    try {
      return await this.courseResourceApiFetcher(client, courseId, this.username);
    } catch (err) {
      const message = redactBrowserDiagnostic(err instanceof Error ? err.message : String(err));
      debugLog('browser-session', `courseresource API path failed; falling back to Playwright: ${message}`);
    }

    await this.ensurePlaywrightReady();

    const ltiUrl = `${BASE_URL}/courses/${courseId}/external_tools/3`;

    return this.withAuthenticatedContext('courseresource', {}, async (context) => {
      const page = await context.newPage();
      const recentResponseUrls: string[] = [];
      const recentRequestUrls: string[] = [];
      const recentFrameUrls: string[] = [];
      const spawnedPageUrls: string[] = [];

      const recordRequest = (url: string): void => {
        if (!isTrackedBrowserUrl(url)) return;
        trackRecent(recentRequestUrls, redactBrowserUrl(url));
      };

      const recordResponse = (url: string, status: number): void => {
        if (!isTrackedBrowserUrl(url)) return;
        trackRecent(recentResponseUrls, `${status} ${redactBrowserUrl(url)}`);
      };

      page.on('request', (request: Request) => {
        recordRequest(request.url());
      });
      page.on('response', (response: Response) => {
        recordResponse(response.url(), response.status());
      });
      page.on('framenavigated', (frame: Frame) => {
        const frameUrl = frame.url();
        if (!frameUrl) return;
        if (!isTrackedBrowserUrl(frameUrl)) return;
        trackRecent(recentFrameUrls, redactBrowserUrl(frameUrl));
      });
      context.on('page', (spawnedPage: Page) => {
        const initialUrl = spawnedPage.url();
        if (initialUrl) trackRecent(spawnedPageUrls, redactBrowserUrl(initialUrl));
        spawnedPage.on('request', (request: Request) => {
          recordRequest(request.url());
        });
        spawnedPage.on('response', (response: Response) => {
          recordResponse(response.url(), response.status());
        });
        spawnedPage.on('framenavigated', (frame: Frame) => {
          const frameUrl = frame.url();
          if (!frameUrl) return;
          if (!isTrackedBrowserUrl(frameUrl)) return;
          const safeFrameUrl = redactBrowserUrl(frameUrl);
          trackRecent(recentFrameUrls, safeFrameUrl);
          trackRecent(spawnedPageUrls, safeFrameUrl);
        });
      });

      const resourcesPromise = page.waitForResponse(
        (response: Response) => response.url().includes('resources_db'),
        { timeout: 30000 },
      ).catch((err: unknown) => {
        if (page.isClosed()) return null;
        throw err;
      });

      await page.goto(ltiUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (isSsoLoginUrl(page.url())) {
        throw sessionRedirectError(page.url());
      }

      let resourcesResponse;
      try {
        resourcesResponse = await resourcesPromise;
      } catch (err) {
        const pageUrl = redactBrowserUrl(page.url());
        const title = await page.title().catch(() => '');
        const popupSummary = summarizeRecent(spawnedPageUrls);
        const frameSummary = summarizeRecent(recentFrameUrls);
        const requestSummary = summarizeRecent(recentRequestUrls);
        const responseSummary = summarizeRecent(recentResponseUrls);
        debugLog('browser-session', `courseresource timeout: page=${pageUrl} title=${title}`);
        debugLog('browser-session', `courseresource timeout recent frames: ${frameSummary}`);
        debugLog('browser-session', `courseresource timeout recent requests: ${requestSummary}`);
        debugLog('browser-session', `courseresource timeout recent responses: ${responseSummary}`);
        debugLog('browser-session', `courseresource timeout spawned pages: ${popupSummary}`);
        const message = redactBrowserDiagnostic(err instanceof Error ? err.message : String(err));
        throw new Error(
          `${message}\n` +
          `  final page: ${pageUrl}\n` +
          `  page title: ${title || '(unknown)'}\n` +
          `  recent frames: ${frameSummary}\n` +
          `  recent requests: ${requestSummary}\n` +
          `  recent responses: ${responseSummary}\n` +
          `  spawned pages: ${popupSummary}`,
        );
      }
      if (!resourcesResponse) {
        throw new Error('courseresource 응답 대기 중 페이지가 닫혔습니다.');
      }
      const body = await resourcesResponse.json() as unknown;
      return parseResourceItems(body);
    });
  }
}
