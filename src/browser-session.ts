import { chromium } from 'playwright';
import type { BrowserContext, Frame, Page, Request, Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CachedToken, ResourceItem } from './types.js';
import { CanvasClient } from './canvas-client.js';
import { deleteCredential, getCredential, setCredential } from './credential-store.js';
import { debugLog } from './secrets.js';
import { fetchCourseResourceViaApi } from './learningx-client.js';
import { parseModulebuilderItems, parseResourceItems } from './resource-items.js';
import { sanitizeFileName } from './utils.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';
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
  try {
    const raw = await getCredential(KEYCHAIN_SERVICE, `token:${username}`);
    return raw ? JSON.parse(raw) as CachedToken : null;
  } catch {
    return null;
  }
}

async function writeTokenToKeychain(username: string, cached: CachedToken): Promise<void> {
  await setCredential(KEYCHAIN_SERVICE, `token:${username}`, JSON.stringify(cached));
}

async function readSessionFromKeychain(username: string): Promise<object | null> {
  try {
    const raw = await getCredential(KEYCHAIN_SERVICE, `session:${username}`);
    return raw ? JSON.parse(raw) as object : null;
  } catch {
    return null;
  }
}

async function writeSessionToKeychain(username: string, state: object): Promise<void> {
  await setCredential(KEYCHAIN_SERVICE, `session:${username}`, JSON.stringify(state));
}

async function deleteSessionFromKeychain(username: string): Promise<void> {
  try {
    await deleteCredential(KEYCHAIN_SERVICE, `session:${username}`);
  } catch {
    // ignore — not present is fine
  }
}

function isTokenValid(cached: CachedToken): boolean {
  const expiresAt = new Date(cached.expires_at).getTime();
  const bufferMs = 60 * 60 * 1000; // 1-hour buffer
  return expiresAt > Date.now() + bufferMs;
}

export function isSsoLoginUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === 'canvas.cau.ac.kr' && url.pathname.startsWith('/xn-sso/')) ||
      (url.hostname === 'eclass3.cau.ac.kr' && url.pathname === '/login')
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

function summarizeRecent(entries: string[]): string {
  return entries.length > 0 ? entries.join(' | ') : 'none';
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
  const finalPage = details.finalPageUrl || '(unknown)';
  const title = details.pageTitle || '(unknown)';
  const recentFrames = summarizeRecent(details.recentFrames);
  const recentRequests = summarizeRecent(details.recentRequests);
  const recentResponses = summarizeRecent(details.recentResponses);
  const mediaCandidates = summarizeRecent(details.mediaCandidates);
  const videoSources = summarizeRecent(details.videoSources);
  const iframeSources = summarizeRecent(details.iframeSources);

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
    if (!this.loginPromise) {
      this.loginPromise = this._doLogin().catch((err: unknown) => {
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
            '  해결: npm -C mcp-server run install:browser',
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

  /**
   * Called by CanvasClient when a request comes back 401: the cached token was
   * expired or revoked server-side, which a locally fabricated expires_at can't
   * detect. Purges the Keychain token and re-logs-in once (single-flight).
   */
  private async refreshTokenAfterAuthError(): Promise<string> {
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = (async () => {
        try {
          debugLog('browser-session', 'Canvas returned 401; purging cached token and re-logging in');
          await deleteCredential(KEYCHAIN_SERVICE, `token:${this.username}`).catch(() => undefined);
          this.client = null;
          this.loginPromise = null;
          const client = await this.getClient();
          return client.getToken();
        } finally {
          this.tokenRefreshPromise = null;
        }
      })();
    }
    return this.tokenRefreshPromise;
  }

  private async _doLogin(): Promise<CanvasClient> {
    // Try cached token from Keychain first
    const cached = await readTokenFromKeychain(this.username);
    if (cached && isTokenValid(cached)) {
      debugLog('browser-session', 'Using cached token');
      this.lastAuthSource = 'cache';
      this.client = new CanvasClient(BASE_URL, cached.token, () => this.refreshTokenAfterAuthError());
      return this.client;
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

      // Issue a new Canvas API token via profile settings UI
      // (The Canvas REST API token endpoint is not accessible on this eclass instance)
      debugLog('browser-session', 'Navigating to profile settings to generate token');
      await page.goto(`${BASE_URL}/profile/settings`, { waitUntil: 'networkidle', timeout: 15000 });

      // Click "새 액세스 토큰" button
      await page.locator('text=새 액세스 토큰').click();
      await page.waitForSelector('#access_token_form', { timeout: 5000 });

      // Fill in purpose
      await page.locator('#access_token_purpose').fill('eclass-mcp');

      // Click the jQuery UI dialog submit button "토큰 생성"
      await page.locator('.ui-dialog-buttonset button:has-text("토큰 생성")').click();

      // Wait for token value to appear in .visible_token
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.visible_token');
          return el !== null && el.textContent !== null && el.textContent.trim().length > 0;
        },
        { timeout: 10000 },
      );

      const rawToken = await page.locator('.visible_token').textContent();
      if (!rawToken || !rawToken.trim()) {
        throw new Error('Token generation succeeded but token value is empty');
      }

      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const tokenResponse = { token: rawToken.trim(), expires_at: expiresAt };

      const newCached: CachedToken = {
        token: tokenResponse.token,
        expires_at: tokenResponse.expires_at ?? expiresAt,
      };

      // Validate token BEFORE persisting — if this fails, nothing is cached
      const validateRes = await fetch(`${BASE_URL}/api/v1/users/self`, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${newCached.token}`, Accept: 'application/json' },
      });
      if (!validateRes.ok) {
        throw new Error(
          `토큰 검증 실패 (${validateRes.status}): 로그인에 문제가 있습니다.\n` +
          '  npm run setup 을 다시 실행하세요.',
        );
      }

      // Persist only after validation succeeds
      const sessionState = await context.storageState();
      await writeSessionToKeychain(this.username, sessionState);
      await writeTokenToKeychain(this.username, newCached);
      debugLog('browser-session', 'New token issued and cached in Keychain');

      this.lastAuthSource = 'login';
      this.client = new CanvasClient(BASE_URL, newCached.token, () => this.refreshTokenAfterAuthError());
      return this.client;
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
    if (parsedLoginUrl.hostname !== 'eclass3.cau.ac.kr') {
      throw new Error(
        '로그인 실패: 아이디 또는 비밀번호가 올바르지 않습니다.\n' +
        '  npm run setup 을 다시 실행하여 비밀번호를 업데이트하세요.',
      );
    }
    debugLog('browser-session', 'Login successful');
  }

  private async refreshBrowserSession(): Promise<void> {
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
            debugLog('browser-session', `${label} redirected to login, refreshing session: ${redirectedUrl}`);
            await deleteSessionFromKeychain(this.username);
            await this.refreshBrowserSession();
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
          throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
          throw new Error(`SESSION_REDIRECT:${warmupPage.url()}`);
        }
      } finally {
        await warmupPage.close();
      }

      const page = await context.newPage();
      try {
        await page.goto(viewerUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(page.url())) {
          throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
        throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
          trackRecent(mediaCandidates, `${label} ${url}`);
        };

        page.on('request', (request: Request) => {
          const url = request.url();
          if (!isTrackedBrowserUrl(url)) return;
          const resourceType = request.resourceType();
          trackRecent(recentRequests, `${request.method()} ${resourceType} ${url}`);
          recordMediaCandidate(`[request:${resourceType}]`, url);
        });
        page.on('response', (response: Response) => {
          const url = response.url();
          if (!isTrackedBrowserUrl(url)) return;
          const resourceType = response.request().resourceType();
          const contentType = response.headers()['content-type'] ?? '';
          trackRecent(recentResponses, `${response.status()} ${resourceType} ${contentType || '(no content-type)'} ${url}`);
          recordMediaCandidate(`[response:${resourceType}:${contentType || 'unknown'}]`, url);
          if (capturedFileUrl) return;
          if (isDownloadableResponse(response)) {
            capturedFileUrl = url;
          }
        });
        page.on('framenavigated', (frame: Frame) => {
          const frameUrl = frame.url();
          if (!frameUrl || !isTrackedBrowserUrl(frameUrl)) return;
          trackRecent(recentFrames, frameUrl);
        });
        context.on('page', (spawnedPage: Page) => {
          spawnedPage.on('request', (request: Request) => {
            const url = request.url();
            if (!isTrackedBrowserUrl(url)) return;
            const resourceType = request.resourceType();
            trackRecent(recentRequests, `${request.method()} ${resourceType} ${url}`);
            recordMediaCandidate(`[popup-request:${resourceType}]`, url);
          });
          spawnedPage.on('response', (response: Response) => {
            const url = response.url();
            if (!isTrackedBrowserUrl(url)) return;
            const resourceType = response.request().resourceType();
            const contentType = response.headers()['content-type'] ?? '';
            trackRecent(recentResponses, `${response.status()} ${resourceType} ${contentType || '(no content-type)'} ${url}`);
            recordMediaCandidate(`[popup-response:${resourceType}:${contentType || 'unknown'}]`, url);
            if (!capturedFileUrl && isDownloadableResponse(response)) {
              capturedFileUrl = url;
            }
          });
          spawnedPage.on('framenavigated', (frame: Frame) => {
            const frameUrl = frame.url();
            if (!frameUrl || !isTrackedBrowserUrl(frameUrl)) return;
            trackRecent(recentFrames, frameUrl);
          });
        });

        debugLog('browser-session', 'Navigating to OCS viewer');
        await page.goto(viewUrl, { waitUntil: 'networkidle', timeout: 30000 });
        if (isSsoLoginUrl(page.url())) {
          throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
            finalPageUrl: page.url(),
            pageTitle,
            recentFrames,
            recentRequests,
            recentResponses,
            mediaCandidates,
            videoSources: domSnapshot.videoSources,
            iframeSources: domSnapshot.iframeSources,
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
        throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
        throw new Error(`SESSION_REDIRECT:${page.url()}`);
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
      const message = err instanceof Error ? err.message : String(err);
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
        trackRecent(recentRequestUrls, url);
      };

      const recordResponse = (url: string, status: number): void => {
        if (!isTrackedBrowserUrl(url)) return;
        trackRecent(recentResponseUrls, `${status} ${url}`);
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
        trackRecent(recentFrameUrls, frameUrl);
      });
      context.on('page', (spawnedPage: Page) => {
        const initialUrl = spawnedPage.url();
        if (initialUrl) trackRecent(spawnedPageUrls, initialUrl);
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
          trackRecent(recentFrameUrls, frameUrl);
          trackRecent(spawnedPageUrls, frameUrl);
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
        throw new Error(`SESSION_REDIRECT:${page.url()}`);
      }

      let resourcesResponse;
      try {
        resourcesResponse = await resourcesPromise;
      } catch (err) {
        const pageUrl = page.url();
        const title = await page.title().catch(() => '');
        const popupSummary = spawnedPageUrls.length > 0 ? spawnedPageUrls.join(' | ') : 'none';
        const frameSummary = recentFrameUrls.length > 0 ? recentFrameUrls.join(' | ') : 'none';
        const requestSummary = recentRequestUrls.length > 0 ? recentRequestUrls.join(' | ') : 'none';
        const responseSummary = recentResponseUrls.length > 0 ? recentResponseUrls.join(' | ') : 'none';
        debugLog('browser-session', `courseresource timeout: page=${pageUrl} title=${title}`);
        debugLog('browser-session', `courseresource timeout recent frames: ${frameSummary}`);
        debugLog('browser-session', `courseresource timeout recent requests: ${requestSummary}`);
        debugLog('browser-session', `courseresource timeout recent responses: ${responseSummary}`);
        debugLog('browser-session', `courseresource timeout spawned pages: ${popupSummary}`);
        const message = err instanceof Error ? err.message : String(err);
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
