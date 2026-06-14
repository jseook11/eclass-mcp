# 엔드포인트 디스커버리 하니스

eclass의 비표준 엔드포인트를 파악할 때 쓰는 개발용 도구. MCP 툴이 아니며 CLI로 직접 실행한다.
새 기능(과제 제출, 성적 등)을 구현하기 전에 실제 엔드포인트/폼 구조를 여기서 먼저 확인한다.

## 보안 원칙 (코드로 강제됨)

- 캡처 출력에 자격증명이 절대 포함되지 않는다:
  - 헤더: allowlist(content-type, accept 등) 외 전부 `[REDACTED]` (authorization, cookie, x-csrf-token 포함)
  - URL 쿼리: token/session/sig/verifier 등 민감 파라미터 값 마스킹
  - 요청 바디: 필드 **이름만** 기록, 값은 절대 기록 안 함
- `submit-flow` 레코더는 제출 버튼을 절대 클릭하지 않는다. 폼을 여는 표준 링크(`.submit_assignment_link`)만 클릭.
- 캡처 대상 origin은 eclass3/ocs/canvas.cau.ac.kr로 제한.

## 자격증명 설정 (개발용)

`npm run setup`을 마쳤다면 추가 설정 없이 터미널에서 바로 실행된다.
`discover.ts`는 doctor와 같은 순서로 자격증명을 찾는다:
셸 env → `~/.hermes/config.yaml` → `.mcp.json` (username), 비밀번호는 자격증명
저장소(OS 키체인 또는 암호화 파일). 헤드리스 서버는 `ECLASS_CREDENTIAL_BACKEND=encrypted`와
`ECLASS_SECRET_KEY`를 주입하면 `secrets.enc`에서 비밀번호를 읽는다(README의 "헤드리스 서버: 암호화 백엔드").

그 외 수동 방법:

1. **`.env` 사용**: `cp .env.example .env` 후 ID/비번 입력.
   `discover.ts`가 시작 시 프로젝트 루트의 `.env`를 자동 로드한다(`.env`는 gitignore됨).
   비밀번호 env를 쓰려면 `ALLOW_PLAINTEXT_ENV_SECRETS=1`도 켜야 한다(`.env.example`에 포함).
   **임시 개발 설정이므로 작업이 끝나면 `.env`를 지우고 비밀번호를 변경할 것.**
2. **셸 환경변수**: `ECLASS_USERNAME=... pnpm run discover api ...` (비번은 키체인 사용).

> 범위: 이 `.env` 자동 로드는 `discover.ts`에만 적용된다. 프로덕션 MCP 서버(`src/index.ts`)는
> `.env`를 읽지 않고 키체인을 그대로 사용한다.

## CLI 사용법

전제: `.env` 설정 또는 `npm run setup` 완료. `pnpm run discover <cmd>` 로 실행.

```bash
# 1. Canvas API 직접 호출 — 표준 API 지원 여부 확인 (가장 먼저 시도)
pnpm run discover api /api/v1/users/self
pnpm run discover api "/api/v1/courses?enrollment_state=active&include[]=total_scores"

# 2. 페이지 로드하며 네트워크 캡처 — API로 안 되는 흐름의 실제 엔드포인트 파악
pnpm run discover page "https://eclass3.cau.ac.kr/courses/12345/grades"

# 3. 과제 제출 플로우 dry-run 레코더 — 제출 UI를 열고 폼 구조·네트워크만 기록 (제출 안 함)
pnpm run discover submit-flow 12345 67890
```

출력은 모두 redact된 JSON (stdout).

- `api`: `{ path, status, content_type, body_preview, body_truncated }`
- `page`: `{ final_page_url, page_title, endpoint_candidates, entries, dropped_entries }`
- `submit-flow`: `{ opened_submission_ui, forms: [{ action, method, fields, submit_buttons }], endpoint_candidates, notes }`

`endpoint_candidates`는 캡처된 요청을 `METHOD origin/path_pattern`으로 그룹화한 요약
(숫자/hex/uuid 세그먼트는 `:id`로 정규화, 정적 리소스 script/image/font/stylesheet 제외).

## 코드 구조

| 파일 | 역할 |
|---|---|
| `src/discovery/redact.ts` | `redactHeaders` / `redactUrl` / `summarizeBody` — 순수 함수 |
| `src/discovery/network-capture.ts` | `NetworkRecorder` (Page/Context에 attach), `summarizeEndpointCandidates`. Playwright 구조적 타입(`RequestLike` 등)을 써서 스텁으로 테스트 가능 |
| `src/discovery/submit-flow-recorder.ts` | `recordAssignmentSubmitFlow(session, courseId, assignmentId)` — dry-run 전용 |
| `src/browser-session.ts` | `BrowserSession.withDiscoveryContext(label, fn)` — 인증된 브라우저 컨텍스트 제공 (세션 만료 시 자동 재로그인 포함) |
| `scripts/discover.ts` | CLI 진입점 |

## 코드에서 쓰는 법

```ts
const report = await session.withDiscoveryContext('my discovery', async (context) => {
  const page = await context.newPage();
  const recorder = new NetworkRecorder();
  recorder.attach(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  if (isSsoLoginUrl(page.url())) throw new Error(`SESSION_REDIRECT:${page.url()}`);
  return { candidates: recorder.summarize(), entries: recorder.entries() };
});
```

`SESSION_REDIRECT:` 접두사 에러를 던지면 `withDiscoveryContext`가 재로그인 후 1회 재시도한다.

## 테스트

`test/redact.test.ts`, `test/network-capture.test.ts` — 전부 모킹 기반 (네트워크/브라우저 불필요).
민감값(토큰/쿠키/CSRF/바디 값)이 출력에 포함되지 않는지 음성 단언으로 검증한다.

## LearningX SIS / 개설강좌 정보 탐사 (시험 일정 v2)

### 목적

`eclass_sync_course_metadata`가 강의명 휴리스틱 대신 LearningX SIS에서
개설대학/학과/교수/과목코드/분반 확정값을 받도록, 실제 endpoint와 응답 schema를 확정한다.
Canvas `syllabus_body`는 사용하지 않는다(결정 사항).

### 호출 패턴

- 인증: 기존 CourseResource LTI launch 패턴 재사용 (`acquireLearningxToken(client, courseId)`).
  Canvas `sessionless_launch` → LTI form POST → `xn_api_token` 쿠키 획득.
- 호출: `https://eclass3.cau.ac.kr/learningx/api/v1/...` 에 `Authorization: Bearer <xn_api_token>` + `Accept: application/json`.

### 확정 endpoint (live 검증: 2026-06-13)

| endpoint | 상태 |
| --- | --- |
| `/learningx/api/v1/courses/{course_id}` | **확정** — 200, `sis_source_id` 포함 |

확정 응답 예시 (course 139260, 컴퓨터시스템및어셈블리언어 01분반):

```json
{
  "id": 139260,
  "name": "컴퓨터시스템및어셈블리언어 01분반",
  "course_code": "컴퓨터시스템및어셈블리언어 01분반",
  "sis_source_id": "2026_1_1_3B510_32734_01",
  "enrollment_term_id": 93
}
```

핵심은 `sis_source_id`의 구조: `{년도}_{학기}_{캠퍼스코드}_{학과코드}_{학수번호}_{분반}`.
`parseSisSourceId()`가 이를 구조적으로 파싱해 course_code(=학수번호)/section/term 확정값을 얻는다.
주의: 이 응답의 `course_code` 필드는 학수번호가 아니라 **표시명**이므로 절대 그대로 쓰지 말 것
(normalize에서 sis_source_id 파싱이 alias 스캔보다 우선하는 이유).

단과대/학과 **이름**은 Canvas `/api/v1/courses/{id}?include[]=account`의 `account.name`으로 얻는다
(직접 `/api/v1/accounts/{id}` 호출은 401이지만 include는 학생 권한으로도 동작, live 검증 2026-06-13).
`account.name` 형태는 `"{단과대} {학부} [{전공}]"`:

- `"소프트웨어대학 소프트웨어학부"` (2026-1 전공/기초과학 과목 전부)
- `"경영경제대학 경영학부(서울) 경영학"` (3토큰 사례)
- `"대학(전체)"` (교양/공통 교과) — 교양대학으로 명시 매핑
- `"중앙대학교"` (비교과: 생명지킴이·인권경영 등, 시험 없음) — 단과대 파싱 불가, 원문만 보존

`parseCanvasAccountName()` 규칙:

1. `KNOWN_ACCOUNT_COLLEGE` 매핑에 있으면 그 값 사용 — 현재 `"대학(전체)" → 교양대학`.
   교양과목 시험 일정은 교양대학(`ge_notice`)이 담당하므로 전체 fallback 대신 정확히 라우팅된다.
2. 첫 토큰이 `…대학`으로 끝나는 2토큰 이상이면 `{college, department}`로 파싱.
3. 그 외는 null + `canvas_account_name` 원문 보존(LLM 판단용).

교수명은 같은 호출의 `include[]=teachers` → `teachers[].display_name`으로 보강한다.

확정 목록은 `src/learningx-client.ts`의 `SIS_COURSE_INFO_ENDPOINT_CANDIDATES`와 동기화한다.

### probe 방법

```bash
# 후보 전체 probe + normalize 결과 출력 (setup 완료 시 env 불필요)
pnpm exec tsx scripts/discover.ts learningx <course_id>

# 특정 경로만 probe
pnpm exec tsx scripts/discover.ts learningx <course_id> /learningx/api/v1/courses/<course_id>/syllabus
```

### normalize 규칙

`normalizeSisCourseInfo(body)`가 응답을 내부 표준 schema로 변환한다.

- 최상위 객체와 한 단계 중첩 객체(`data`, `sis_course` 등)에서 별칭 키를 탐색한다
  (예: `colg_nm → college`, `subj_no → course_code`, `class_no → section`).
- `raw_sis_course_id`가 `parseSisSourceId()` 형식이면 **구조 파싱 결과가 alias 스캔을 덮어쓴다**
  (live 응답의 `course_code`가 표시명이기 때문). 이것이 확정된 기본 경로다.
- `course_code`와 `section`을 찾지 못하면 실패로 처리하고, 발견한 키 목록을 에러 메시지에 남긴다
  → 호출자는 `canvas_only`로 강등한다.

### live verification 여부

**live 검증 완료** (2026-06-13, course 139260). `/learningx/api/v1/courses/{id}` 200 확인,
`sis_source_id` 구조 파싱 경로가 기본. schema가 다시 바뀌면 위 probe 명령으로 재탐사 후
이 문서와 `SIS_FIELD_KEYS` / `SIS_COURSE_INFO_ENDPOINT_CANDIDATES`를 갱신할 것.

### 버린 endpoint와 이유

- Canvas `/api/v1/courses/{id}`의 `syllabus_body`: 자유 서식 HTML(OZ viewer iframe)이라 확정값 추출 불가 + 스펙에서 사용 금지로 결정.
- `/learningx/api/v1/courses/{id}/sis_course/check`: 200이지만 body가 boolean `true` — SIS 연동 여부 확인용일 뿐 과목 정보 없음 (live 확인).
- `/learningx/api/v1/courses/{id}/sis_course`, `/learningx/api/v1/courses/{id}/info`: 404 (live 확인).
- `/api/v1/accounts/{account_id}` 직접 호출: 401 (학생 권한 없음) — 대신 course의 `include[]=account`를 사용한다.
