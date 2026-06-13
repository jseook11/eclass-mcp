import { CanvasClient } from './canvas-client.js';
import type { ResourceItem } from './types.js';
import { parseResourceItems } from './resource-items.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';
const LEARNINGX_API_ORIGIN = 'https://eclass3.cau.ac.kr';
const DEFAULT_COURSERESOURCE_TOOL_ID = 3;
const REQUEST_TIMEOUT_MS = 30_000;

interface SessionlessLaunchResponse {
  url?: string;
}

interface CanvasUserSelf {
  login_id?: string | null;
  sis_user_id?: string | null;
  integration_id?: string | null;
}

interface CanvasTab {
  id?: string;
  label?: string;
  html_url?: string;
}

interface LaunchDefinition {
  definition_id?: number | string;
  name?: string;
  description?: string | null;
  placements?: Record<string, { url?: string }>;
}

interface LtiForm {
  action: string;
  fields: URLSearchParams;
}

const courseResourceToolCache = new Map<number, number>();

function assertEclassUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} rejected: invalid URL`);
  }
  if (url.protocol !== 'https:' || url.origin !== LEARNINGX_API_ORIGIN) {
    throw new Error(`${label} rejected: unexpected origin`);
  }
  return url;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(attrPattern)) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

export function parseLtiForm(html: string): LtiForm {
  const formMatch = /<form\b[^>]*>/i.exec(html);
  if (!formMatch) {
    throw new Error('LearningX LTI form missing form tag');
  }
  const formAttrs = parseAttributes(formMatch[0]);
  const action = formAttrs['action'];
  if (!action) {
    throw new Error('LearningX LTI form missing action');
  }

  const fields = new URLSearchParams();
  const inputPattern = /<input\b[^>]*>/gi;
  for (const match of html.matchAll(inputPattern)) {
    const attrs = parseAttributes(match[0]);
    const name = attrs['name'];
    if (!name) continue;
    fields.append(name, attrs['value'] ?? '');
  }
  if ([...fields.keys()].length === 0) {
    throw new Error('LearningX LTI form has no fields');
  }
  return { action, fields };
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const direct = withGetSetCookie.getSetCookie?.();
  if (direct && direct.length > 0) return direct;
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((part) => part.trim()).filter(Boolean);
}

export function extractLearningxToken(headers: Headers): string {
  for (const cookie of getSetCookieHeaders(headers)) {
    const match = /(?:^|;\s*)xn_api_token=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  throw new Error('LearningX API token cookie missing');
}

async function fetchJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`LearningX API error ${response.status}`);
  }
  return await response.json() as T;
}

function courseResourceLaunchPath(courseId: number, toolId: number): string {
  return `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=${toolId}&launch_type=course_navigation`;
}

async function getSessionlessLaunch(client: CanvasClient, courseId: number, toolId: number): Promise<string> {
  const response = await client.fetchOne<SessionlessLaunchResponse>(courseResourceLaunchPath(courseId, toolId));
  if (!response.url) {
    throw new Error('Canvas sessionless_launch response missing url');
  }
  assertEclassUrl(response.url, 'sessionless_launch url');
  return response.url;
}

function matchesCourseResourceText(...values: Array<string | null | undefined>): boolean {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  return text.includes('강의자료실') ||
    text.includes('courseresource') ||
    text.includes('course resource') ||
    text.includes('learningx/lti/courseresource');
}

function extractToolId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const match = /(?:context_external_tool_|external_tools\/|^)(\d+)(?:\D|$)/.exec(raw);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

async function resolveCourseResourceToolId(client: CanvasClient, courseId: number): Promise<number> {
  const cached = courseResourceToolCache.get(courseId);
  if (cached) return cached;

  const tabs = await client.fetchOne<CanvasTab[]>(`/api/v1/courses/${courseId}/tabs`);
  for (const tab of tabs) {
    if (!matchesCourseResourceText(tab.label, tab.id, tab.html_url)) continue;
    const id = extractToolId(tab.id) ?? extractToolId(tab.html_url);
    if (id) {
      courseResourceToolCache.set(courseId, id);
      return id;
    }
  }

  const definitions = await client.fetchOne<LaunchDefinition[]>(
    `/api/v1/courses/${courseId}/lti_apps/launch_definitions?placements[]=course_navigation&placements[]=link_selection&placements[]=assignment_view`,
  );
  for (const definition of definitions) {
    const placementUrls = Object.values(definition.placements ?? {}).map((placement) => placement.url).join(' ');
    if (!matchesCourseResourceText(definition.name, definition.description, placementUrls)) continue;
    const id = extractToolId(definition.definition_id) ?? extractToolId(placementUrls);
    if (id) {
      courseResourceToolCache.set(courseId, id);
      return id;
    }
  }

  throw new Error('CourseResource external tool id not found');
}

async function launchLearningx(client: CanvasClient, courseId: number, toolId: number): Promise<string> {
  const launchUrl = await getSessionlessLaunch(client, courseId, toolId);
  const launchResponse = await fetch(launchUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!launchResponse.ok) {
    throw new Error(`LearningX launch form fetch failed ${launchResponse.status}`);
  }

  const form = parseLtiForm(await launchResponse.text());
  assertEclassUrl(form.action, 'LearningX LTI action');
  const ltiResponse = await fetch(form.action, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml',
    },
    body: form.fields,
  });
  if (ltiResponse.status < 200 || ltiResponse.status >= 400) {
    throw new Error(`LearningX LTI post failed ${ltiResponse.status}`);
  }
  return extractLearningxToken(ltiResponse.headers);
}

async function getUserLogin(client: CanvasClient, fallbackUsername: string): Promise<string> {
  try {
    const self = await client.fetchOne<CanvasUserSelf>('/api/v1/users/self');
    const candidate = self.login_id ?? self.sis_user_id ?? self.integration_id ?? fallbackUsername;
    return String(candidate).trim() || fallbackUsername;
  } catch {
    return fallbackUsername;
  }
}

/**
 * 기존 CourseResource LTI launch 흐름을 재사용해 LearningX API 토큰(xn_api_token)을 얻는다.
 * 시험 일정 v2의 SIS 조회와 discovery CLI가 공유한다.
 */
export async function acquireLearningxToken(client: CanvasClient, courseId: number): Promise<string> {
  let toolId = courseResourceToolCache.get(courseId) ?? DEFAULT_COURSERESOURCE_TOOL_ID;
  let token: string;
  try {
    token = await launchLearningx(client, courseId, toolId);
  } catch (err) {
    if (toolId !== DEFAULT_COURSERESOURCE_TOOL_ID) throw err;
    toolId = await resolveCourseResourceToolId(client, courseId);
    token = await launchLearningx(client, courseId, toolId);
  }
  courseResourceToolCache.set(courseId, toolId);
  return token;
}

export async function fetchCourseResourceViaApi(
  client: CanvasClient,
  courseId: number,
  fallbackUsername: string,
): Promise<ResourceItem[]> {
  const token = await acquireLearningxToken(client, courseId);
  const userLogin = await getUserLogin(client, fallbackUsername);
  const resourcesUrl = new URL(`${BASE_URL}/learningx/api/v1/courses/${courseId}/resources_db`);
  resourcesUrl.searchParams.set('user_login', userLogin);
  const body = await fetchJson<unknown>(resourcesUrl, token);
  // strict: 응답 형태를 인식하지 못하면 throw → 호출자가 Playwright 폴백으로 전환
  return parseResourceItems(body, { strict: true });
}

// --- LearningX SIS / 개설강좌 정보 (시험 일정 v2) ---
//
// endpoint는 라이브 탐사로 확정됐다 (2026-06-13, docs/DISCOVERY.md 참고).
// `/learningx/api/v1/courses/{id}` 가 sis_source_id("2026_1_1_3B510_32734_01" 형태)를
// 반환하며, 여기서 course_code/section/term을 구조적으로 파싱한다.
// schema가 다시 바뀌면 `pnpm exec tsx scripts/discover.ts learningx <course_id>` 로 probe.

export const SIS_COURSE_INFO_ENDPOINT_CANDIDATES: ReadonlyArray<(courseId: number) => string> = [
  (courseId) => `/learningx/api/v1/courses/${courseId}`,
];

export interface SisCourseInfo {
  college: string | null;
  department: string | null;
  instructor: string | null;
  course_code: string | null;
  section: string | null;
  term: string | null;
  raw_sis_course_id: string | null;
}

export type SisCourseInfoResult =
  | { ok: true; endpoint: string; info: SisCourseInfo }
  | {
      ok: false;
      error_code: 'SIS_AUTH_FAILED' | 'SIS_ENDPOINT_UNAVAILABLE' | 'SIS_RESPONSE_UNRECOGNIZED';
      message: string;
    };

const SIS_FIELD_KEYS: Record<keyof SisCourseInfo, string[]> = {
  college: ['college', 'college_name', 'college_nm', 'colg_nm', 'univ_nm'],
  department: ['department', 'department_name', 'dept_nm', 'sust_nm', 'major_nm'],
  instructor: ['instructor', 'instructor_name', 'prof_nm', 'staff_nm', 'teacher_name'],
  course_code: ['course_code', 'subj_no', 'sbjt_no', 'haksu_no', 'subject_code'],
  section: ['section', 'class_no', 'divcls_no', 'dvcls_no', 'bunban'],
  term: ['term', 'term_name', 'semester', 'shtm_nm', 'year_term'],
  raw_sis_course_id: ['sis_course_id', 'sis_id', 'sis_source_id', 'source_id'],
};

function asTrimmedString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * sis_source_id를 구조적으로 파싱한다 (live 검증된 형식, 추론 아님):
 * `{년도}_{학기}_{캠퍼스코드}_{학과코드}_{학수번호}_{분반}` — 예: 2026_1_1_3B510_32734_01
 */
export function parseSisSourceId(raw: string): {
  term: string;
  campus_code: string;
  department_code: string;
  course_code: string;
  section: string;
} | null {
  const match = /^(\d{4})_(\d{1,2})_([^_]+)_([^_]+)_([^_]+)_([^_]+)$/.exec(raw.trim());
  if (!match) return null;
  return {
    term: `${match[1]}-${match[2]}`,
    campus_code: match[3],
    department_code: match[4],
    course_code: match[5],
    section: match[6],
  };
}

function collectSisObjects(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) return [];
  const root = body as Record<string, unknown>;
  const objects: Record<string, unknown>[] = [root];
  // 응답이 {data: {...}} / {sis_course: {...}} 처럼 한 단계 감싸진 경우까지만 본다.
  for (const value of Object.values(root)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      objects.push(value as Record<string, unknown>);
    }
  }
  return objects;
}

/**
 * SIS 응답을 내부 표준 schema로 normalize한다. 시스템 경계 검증 지점:
 * course_code + section을 찾지 못하면 실패를 반환하고, 호출자는 canvas_only로 강등한다.
 */
export function normalizeSisCourseInfo(body: unknown):
  | { ok: true; info: SisCourseInfo }
  | { ok: false; message: string } {
  const objects = collectSisObjects(body);
  if (objects.length === 0) {
    return { ok: false, message: 'SIS response is not a JSON object' };
  }

  const info: SisCourseInfo = {
    college: null,
    department: null,
    instructor: null,
    course_code: null,
    section: null,
    term: null,
    raw_sis_course_id: null,
  };
  for (const field of Object.keys(SIS_FIELD_KEYS) as Array<keyof SisCourseInfo>) {
    for (const key of SIS_FIELD_KEYS[field]) {
      for (const obj of objects) {
        const candidate = asTrimmedString(obj[key]);
        if (candidate !== null) {
          info[field] = candidate;
          break;
        }
      }
      if (info[field] !== null) break;
    }
  }

  // 구조화된 sis_source_id가 있으면 alias 스캔보다 우선한다. live 응답의
  // `course_code`는 표시명("컴퓨터시스템및어셈블리언어 01분반")이라 alias 스캔이
  // 학수번호 대신 표시명을 집을 수 있기 때문이다.
  if (info.raw_sis_course_id) {
    const parsed = parseSisSourceId(info.raw_sis_course_id);
    if (parsed) {
      info.course_code = parsed.course_code;
      info.section = parsed.section;
      info.term = parsed.term;
      return { ok: true, info };
    }
  }

  if (!info.course_code || !info.section) {
    const seenKeys = [...new Set(objects.flatMap((obj) => Object.keys(obj)))].slice(0, 40);
    return {
      ok: false,
      message: `SIS response missing course_code/section. keys=[${seenKeys.join(', ')}]`,
    };
  }
  return { ok: true, info };
}

/**
 * LearningX SIS / 개설강좌 정보를 조회한다. 실패해도 throw하지 않고 structured error를 반환한다.
 */
export async function fetchSisCourseInfo(client: CanvasClient, courseId: number): Promise<SisCourseInfoResult> {
  let token: string;
  try {
    token = await acquireLearningxToken(client, courseId);
  } catch (err) {
    return {
      ok: false,
      error_code: 'SIS_AUTH_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const failures: string[] = [];
  for (const toPath of SIS_COURSE_INFO_ENDPOINT_CANDIDATES) {
    const endpointPath = toPath(courseId);
    let body: unknown;
    try {
      body = await fetchJson<unknown>(new URL(`${BASE_URL}${endpointPath}`), token);
    } catch (err) {
      failures.push(`${endpointPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const normalized = normalizeSisCourseInfo(body);
    if (normalized.ok) {
      return { ok: true, endpoint: endpointPath, info: normalized.info };
    }
    failures.push(`${endpointPath}: ${normalized.message}`);
  }

  const unrecognized = failures.some((f) => f.includes('SIS response'));
  return {
    ok: false,
    error_code: unrecognized ? 'SIS_RESPONSE_UNRECOGNIZED' : 'SIS_ENDPOINT_UNAVAILABLE',
    message: failures.join(' | ') || 'no SIS endpoint candidates configured',
  };
}
