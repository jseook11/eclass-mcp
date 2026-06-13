// Endpoint discovery CLI. Live runs require credentials configured via setup.
//
//   pnpm exec tsx scripts/discover.ts api <path>                        Canvas API probe (e.g. /api/v1/users/self)
//   pnpm exec tsx scripts/discover.ts page <url>                        capture network while loading an eclass page
//   pnpm exec tsx scripts/discover.ts submit-flow <course_id> <assignment_id>   dry-run assignment submit recorder
//   pnpm exec tsx scripts/discover.ts learningx <course_id> [path]    LearningX SIS endpoint probe (시험 일정 v2)
//
// Output is redacted (no cookies/tokens/CSRF/body values) and printed as JSON.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserSession, isSsoLoginUrl } from '../src/browser-session.js';
import {
  acquireLearningxToken,
  normalizeSisCourseInfo,
  SIS_COURSE_INFO_ENDPOINT_CANDIDATES,
} from '../src/learningx-client.js';
import { getEclassPassword } from '../src/secrets.js';
import { resolveDoctorCredentials } from '../src/doctor.js';
import { NetworkRecorder, isTrackedDiscoveryUrl } from '../src/discovery/network-capture.js';
import { recordAssignmentSubmitFlow } from '../src/discovery/submit-flow-recorder.js';
import { redactUrl } from '../src/discovery/redact.js';

// Dev convenience: load credentials from a local .env if present. Without it,
// buildSession() falls back to the setup-managed configs (env → Hermes →
// .mcp.json) plus the OS keychain, so a plain terminal run works after
// `npm run setup`. The production server (src/index.ts) does NOT auto-load
// .env and keeps using the keychain. .env is gitignored.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
  process.stderr.write(`[discover] loaded ${envPath}\n`);
}

const BASE_URL = 'https://eclass3.cau.ac.kr';
const MAX_BODY_PREVIEW = 4000;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function buildSession(): Promise<BrowserSession> {
  // Same resolution order as doctor: env → Hermes config → .mcp.json. setup
  // writes the username into .mcp.json (not the shell env), so a plain
  // terminal run must fall back to those files.
  const credentials = await resolveDoctorCredentials();
  const username = credentials.username;
  if (!username) {
    fail('ECLASS_USERNAME을 찾지 못했습니다 (env / ~/.hermes/config.yaml / .mcp.json). npm run setup 을 먼저 실행하세요.');
  }
  return new BrowserSession(username, () => getEclassPassword(
    username,
    credentials.envPassword,
    undefined,
    credentials.plaintextOverride,
  ));
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function probeApi(path: string): Promise<void> {
  if (!path.startsWith('/api/')) fail('api 경로는 /api/ 로 시작해야 합니다.');
  const session = await buildSession();
  const client = await session.getClient();
  const response = await fetch(BASE_URL + path, {
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${client.getToken()}`,
      Accept: 'application/json+canvas-string-ids, application/json',
    },
  });
  const bodyText = await response.text();
  printJson({
    path,
    status: response.status,
    content_type: response.headers.get('content-type'),
    body_preview: bodyText.slice(0, MAX_BODY_PREVIEW),
    body_truncated: bodyText.length > MAX_BODY_PREVIEW,
  });
}

async function capturePage(rawUrl: string): Promise<void> {
  if (!isTrackedDiscoveryUrl(rawUrl)) {
    fail('허용된 origin이 아닙니다 (eclass3/ocs/canvas.cau.ac.kr만 지원).');
  }
  const session = await buildSession();
  const report = await session.withDiscoveryContext('page discovery', async (context) => {
    const page = await context.newPage();
    const recorder = new NetworkRecorder();
    recorder.attach(page);
    await page.goto(rawUrl, { waitUntil: 'networkidle', timeout: 30000 });
    if (isSsoLoginUrl(page.url())) {
      throw new Error(`SESSION_REDIRECT:${page.url()}`);
    }
    return {
      requested_url: redactUrl(rawUrl),
      final_page_url: redactUrl(page.url()),
      page_title: await page.title().catch(() => ''),
      endpoint_candidates: recorder.summarize(),
      entries: recorder.entries(),
      dropped_entries: recorder.droppedCount(),
    };
  });
  printJson(report);
}

// 시험 일정 v2: LearningX SIS / 개설강좌 endpoint 후보를 LTI 토큰으로 probe한다.
// path 생략 시 SIS_COURSE_INFO_ENDPOINT_CANDIDATES 전체 + normalize 결과를 출력한다.
async function probeLearningx(courseIdRaw: string, customPath?: string): Promise<void> {
  const courseId = Number(courseIdRaw);
  if (!Number.isInteger(courseId) || courseId <= 0) fail('course_id는 양의 정수여야 합니다.');
  if (customPath && !customPath.startsWith('/learningx/')) fail('path는 /learningx/ 로 시작해야 합니다.');
  const session = await buildSession();
  const client = await session.getClient();
  const token = await acquireLearningxToken(client, courseId);

  const paths = customPath
    ? [customPath]
    : SIS_COURSE_INFO_ENDPOINT_CANDIDATES.map((toPath) => toPath(courseId));
  const probes = [];
  for (const path of paths) {
    const response = await fetch(BASE_URL + path, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const bodyText = await response.text();
    let normalized: unknown = null;
    if (response.ok) {
      try {
        normalized = normalizeSisCourseInfo(JSON.parse(bodyText));
      } catch {
        normalized = { ok: false, message: 'body is not JSON' };
      }
    }
    probes.push({
      path,
      status: response.status,
      content_type: response.headers.get('content-type'),
      body_preview: bodyText.slice(0, MAX_BODY_PREVIEW),
      body_truncated: bodyText.length > MAX_BODY_PREVIEW,
      normalized,
    });
  }
  printJson({ course_id: courseId, probes });
}

async function captureSubmitFlow(courseIdRaw: string, assignmentIdRaw: string): Promise<void> {
  const courseId = Number(courseIdRaw);
  const assignmentId = Number(assignmentIdRaw);
  if (!Number.isInteger(courseId) || courseId <= 0) fail('course_id는 양의 정수여야 합니다.');
  if (!Number.isInteger(assignmentId) || assignmentId <= 0) fail('assignment_id는 양의 정수여야 합니다.');
  const session = await buildSession();
  const report = await recordAssignmentSubmitFlow(session, courseId, assignmentId);
  printJson(report);
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'api':
    if (rest.length !== 1) fail('사용법: discover.ts api <path>');
    await probeApi(rest[0]);
    break;
  case 'page':
    if (rest.length !== 1) fail('사용법: discover.ts page <url>');
    await capturePage(rest[0]);
    break;
  case 'submit-flow':
    if (rest.length !== 2) fail('사용법: discover.ts submit-flow <course_id> <assignment_id>');
    await captureSubmitFlow(rest[0], rest[1]);
    break;
  case 'learningx':
    if (rest.length < 1 || rest.length > 2) fail('사용법: discover.ts learningx <course_id> [/learningx/api/...]');
    await probeLearningx(rest[0], rest[1]);
    break;
  case 'syllabus': {
    if (rest.length !== 6) fail('사용법: discover.ts syllabus <year> <term> <campcd> <sust> <sbjtno1> <clssno1>');
    const [year, term, campcd, sust, sbjtno1, clssno1] = rest;
    const session = await buildSession();
    const { getSyllabus, searchSyllabusList } = await import('../src/mportal-client.js');
    const search = await searchSyllabusList(session, { year, term, query: '' });
    const detail = await getSyllabus(session, { year, term, campcd, sust, sbjtno1, clssno1 });
    printJson({ search, detail });
    break;
  }
  default:
    fail(
      '사용법:\n' +
      '  discover.ts api <path>\n' +
      '  discover.ts page <url>\n' +
      '  discover.ts submit-flow <course_id> <assignment_id>\n' +
      '  discover.ts learningx <course_id> [/learningx/api/...]\n' +
      '  discover.ts syllabus <year> <term> <campcd> <sust> <sbjtno1> <clssno1>',
    );
}
