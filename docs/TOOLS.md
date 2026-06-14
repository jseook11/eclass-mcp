# eclass-mcp 툴 사용 가이드

MCP 클라이언트(Claude, Codex 등)에서 각 툴을 어떻게 쓰는지 정리한 문서.
skill/하네스 작성 시 이 문서를 참조한다. 새 툴이 추가되면 여기에 같이 기록한다.
엔드포인트 디스커버리 개발 도구는 [DISCOVERY.md](DISCOVERY.md) 참조.

## 공통 사항

- 모든 툴은 기존 클라이언트 호환을 위해 JSON 문자열을 `content[0].text`로 반환한다.
  ChatGPT/remote MCP 호환을 위해 가능한 경우 같은 값을 `structuredContent`에도 함께 싣는다.
  배열 결과는 `structuredContent.result`로 감싼다.
- 모든 노출 툴은 `tools/list`에서 `outputSchema`(JSON Schema, 항상 `type: "object"`)를 함께 내보낸다
  (`src/tools/registry.ts`의 `ECLASS_OUTPUT_SCHEMAS`, `buildToolList`가 주입). 아래 각 툴의 "출력"
  명세가 이 스키마의 근거(SSOT)다 — 출력 형태를 바꾸면 registry의 스키마도 같이 고친다.
  - 배열 반환 툴(`eclass_get_courses`, `eclass_get_courses_cached`, `eclass_get_assignments`,
    `eclass_get_announcements`, `eclass_list_downloads`)은 `structuredContent.result` 래핑에 맞춰
    `{ result: [...] }` 형태로 기술한다.
  - 스키마는 느슨하다(`additionalProperties` 미지정 = 허용, `required`는 성공/실패와 무관하게 항상
    존재하는 최소 필드만). partial success·optional 필드·`{ ok: false, error_code, ... }` 실패 응답이
    같은 스키마로 통과한다.
- 툴 description은 `[로컬]`/`[네트워크]` 접두사로 비용을 표시한다. `[로컬]`은 로컬 DB/캐시만 사용해 즉시 반환, `[네트워크]`는 Canvas API 호출이며 첫 호출 시 자동 로그인이 끼어들 수 있다. 같은 정보를 얻을 수 있다면 `[로컬]` 도구를 우선한다.
- 인증은 서버가 알아서 처리한다 (Keychain 토큰 캐시 → 만료 시 Playwright 자동 로그인). 호출 측에서 신경 쓸 것 없음.
  - 서버 측에서 토큰이 만료/회수되어 401이 돌아오면 캐시 토큰을 폐기하고 자동 재로그인 후 해당 요청을 1회 재시도한다.
- 모든 HTTP 요청에 타임아웃이 걸려 있다 (API 30초, 파일 다운로드 5분, 동영상 다운로드 30분). eclass가 응답을 멈춰도 툴이 무한 대기하지 않는다.
- `course_id`는 숫자. 강의명으로 찾으려면 먼저 강의 목록을 불러와서 LLM이 직접 매칭한다 (별도 검색 툴 없음 — 아래 "강의 찾기 흐름" 참조).
- 첫 호출(로그인 필요 시)은 20초 이상 걸릴 수 있다. 이후는 토큰 캐시로 빠름.
- 다운로드 파일명은 유니코드 인식 정규화를 거친다 — 한글 파일명이 그대로 보존된다 (위험 문자만 `_` 치환).
- 시험 시간표 기능은 기존 다운로드 DB와 별도 DB를 사용한다. 기본 경로는 `~/.eclass-mcp/exams.db`이며 `ECLASS_EXAM_DB_PATH`로 바꿀 수 있다.

## 강의 찾기 흐름 (course_id 알아내기)

1. `eclass_get_courses_cached` 호출 — 네트워크 없이 즉시 반환. 결과가 있으면 목록에서 LLM이 직접 이름을 보고 course_id 선택.
2. 캐시가 비었거나 강의가 안 보이면 `eclass_get_courses` 호출 — eclass에서 현재 수강 목록을 가져오고 캐시도 갱신됨.

## 툴 목록

### search

ChatGPT Company Knowledge / connector-like 호환용 표준 검색 도구. eclass 강의, 과제,
공지, 자료, 강의계획서 후보, 로컬 다운로드 기록을 best-effort로 통합 검색한다.

- 입력: `{ query: string }`
- 출력: `{ results: [{ id, title, url }] }`
- `id`는 `fetch`에 넘기는 canonical id다. 예:
  - `eclass://course/<course_id>`
  - `eclass://assignment/<course_id>/<assignment_id>`
  - `eclass://announcement/<course_id>/<announcement_id>`
  - `eclass://material/<course_id>/<material_id>`
  - `eclass://syllabus/<year>/<term>/<course_code>/<section>?campcd=...&sust=...`
  - `eclass://download/<file_id>`
- 검색 중 일부 source가 실패해도 가능한 결과를 반환한다.
- 응답 지연을 막기 위해 전체 검색은 제한된 시간 예산 안에서 best-effort로 동작한다.
  공지/자료 본문 스캔은 검색어가 강의명과 일치하는 일부 강의로 제한된다.

### fetch

`search` 결과의 canonical id를 받아 상세 텍스트를 반환하는 표준 조회 도구.

- 입력: `{ id: string }`
- 출력: `{ id, title, text, url, metadata? }`
- `text`는 해당 항목의 구조화 JSON을 사람이 읽을 수 있게 pretty-print한 문자열이다.

### eclass_get_courses

수강 중인 강의 목록 (현재 학기 기준 필터링). 호출하면 강의 캐시도 갱신된다.

- 입력: 없음
- 출력: `[{ id: number, name: string }]`

### eclass_get_courses_cached

로컬 캐시의 강의 목록. 네트워크 호출 없음. course_id ↔ 강의명 매핑용.

- 입력: `{ course_id?: number }` — 지정 시 해당 강의만
- 출력: `[{ id, name, fetched_at }]`

### eclass_doctor

사전 점검. Playwright 실행 가능 여부, 인증, courses API, courseresource API/폴백 경로를 확인.

- 입력: 없음
- 출력: `{ checked_at, checks: [{ name, ok, detail }] }`
- 사용 시점: 다른 툴이 인증/브라우저 오류를 낼 때 원인 파악용.

### eclass_get_assignments

과제·퀴즈 목록.

- 입력: `{ course_id?, days_ahead?: number = 30, include_submitted?: boolean = true }`
- 출력: `[{ assignment_id?, title, course_name, due_at, is_submitted, is_missing, url, submission_types?, allowed_extensions?, allowed_attempts? }]`
- 동작:
  - `course_id`가 있으면 Canvas course assignments API를 우선 사용해 `assignment_id`, `submission_types`, `allowed_extensions`, `allowed_attempts`를 함께 반환한다.
  - `course_id`가 없으면 기존처럼 Canvas planner API를 사용해 전체 강의의 마감 임박 항목을 조회한다.
- 주의: `due_at`은 KST ISO 문자열 또는 null. 더 자세한 배점·잠금·점수 정보는 `eclass_get_assignment_detail` 사용.
- 주의: `course_id` 지정 시 `days_ahead` 상한이 적용되지 않는다 — 해당 강의의 미래 마감 과제가 전부 반환되므로 "N일 이내만"이 필요하면 호출 측에서 `due_at`으로 직접 거른다.

### eclass_get_assignment_detail

단일 과제의 상세 정보. 과제 제출 전 제출 유형·허용 확장자 확인용.

- 입력: `{ course_id: number, assignment_id: number }`
- 출력(성공): `{ ok: true, assignment: { id, course_id, name, due_at, unlock_at, lock_at, points_possible, grading_type, submission_types[], allowed_extensions[], allowed_attempts, has_submitted, submitted_at, attempt, workflow_state, score, grade, graded_at, html_url } }`
  - `allowed_attempts`: `-1`은 무제한 (Canvas 규약).
  - `submission_types`: 예 `["online_upload"]`, `["external_tool"]`, `["online_text_entry"]`.
  - 날짜는 KST ISO 또는 null.
- 출력(실패): `{ ok: false, error_code, message, retryable, next_action?, debug? }` — 예: `ASSIGNMENT_NOT_FOUND`.
- `assignment_id`는 `eclass_get_assignments`의 `url` 끝 숫자에서 얻거나, 과제 페이지 URL에서 확인.

### eclass_submit_assignment

과제를 제출한다. 안전을 위해 기본값은 `dry_run: true`이며, 이 경우 실제 제출/업로드 요청은 하지 않고 과제 상태·제출 유형·확장자·마감·재제출 조건만 검증한다.

- 입력: `{ course_id: number, assignment_id: number, file_paths?: string[], body?: string, comment?: string, dry_run?: boolean = true, confirm_resubmit?: boolean = false }`
  - `file_paths`: `online_upload` 과제에 업로드할 로컬 파일 경로.
  - `body`: `online_text_entry` 과제의 본문. `file_paths`와 동시에 지정할 수 없음.
  - `comment`: 제출 코멘트.
  - `confirm_resubmit`: 이미 제출된 과제를 재제출할 때 반드시 `true`로 지정.
- 출력(성공): `{ ok: true, mode: 'dry_run'|'submitted', already_submitted, is_resubmission, validation, strategy, submitted_at?, attempt?, verification? }`
  - `strategy`: 우선 `canvas_api`를 사용하고, 업로드 단계 실패 시 Playwright UI 폴백(`playwright_ui`)을 시도. UI 폴백은 **단일 파일 제출만** 지원한다 (확인된 Canvas 폼이 단일 file input).
  - Canvas 업로드 2단계에서 스토리지가 redirect(`success_action_redirect`)를 반환하면 finalize URL을 Bearer 토큰으로 GET해 파일 id를 확정한다 (표준 Canvas 3단계 플로우).
  - **이중 제출 방지**: 최종 제출 POST가 모호하게 실패하면(타임아웃 등) 과제 상세를 재조회해 제출 반영 여부를 먼저 판정한다. 이미 반영되었으면 폴백하지 않고 성공 처리하고, 반영 여부를 확인하지 못하면 자동 재시도 없이 실패로 보고한다.
  - 제출 후에는 과제 상세를 재조회해 `has_submitted`와 재제출 시 `attempt` 증가(또는 attempt가 없으면 `submitted_at` 변화)를 확인.
- 출력(실패): `{ ok: false, error_code, message, retryable, next_action?, debug? }`
  - 주요 코드: `ASSIGNMENT_SUBMISSION_UNSUPPORTED_TYPE`, `ASSIGNMENT_EXTENSION_NOT_ALLOWED`, `ASSIGNMENT_LOCKED`, `ASSIGNMENT_ALREADY_SUBMITTED`, `SUBMISSION_FILE_NOT_FOUND`, `SUBMISSION_UPLOAD_FAILED`(업로드 단계 실패), `SUBMISSION_FAILED`(제출 단계 실패), `SUBMISSION_VERIFICATION_FAILED`.
- 주의: 실제 제출은 `dry_run: false`일 때만 수행된다. 되돌리기 어려운 과제 재제출 전에는 먼저 `dry_run: true` 결과를 확인한다.
- 주의: `online_upload`/`online_text_entry`만 지원한다. `submission_types`가 `external_tool`(LTI)인 과제는 이 툴로 제출할 수 없으므로 (`ASSIGNMENT_SUBMISSION_UNSUPPORTED_TYPE`), 제출 전 `eclass_get_assignment_detail`로 유형을 확인한다.

### eclass_get_grades

성적 조회. 강의 단위 점수 + 과제별 점수.

- 입력: `{ course_id?: number, include_assignments?: boolean = true }`
- 출력: `{ ok, courses: [{ course_id, course_name, current_score, current_grade, final_score, final_grade, assignments?: [{ assignment_id, name, score, grade, points_possible, submitted, submitted_at, graded_at, workflow_state }] }], errors: [{ scope, reason, retryable }] }`
  - `course_id` 생략 시 전체 강의. `include_assignments: false`면 강의 단위 점수만 (빠름).
  - 일부 강의의 과제 조회 실패는 `errors[]`에 `scope: "course:<id>"`로 기록되고 나머지는 정상 반환 (partial success).

### eclass_sync_course_metadata

시험 시간표 매칭용 강의 메타데이터를 별도 시험 DB에 저장한다. LearningX SIS(개설강좌 정보)에서 개설대학/학과/교수/과목코드/분반 **확정값**을 받아 저장한다. 강의명 규칙 추정(휴리스틱)과 confidence는 v2에서 제거됐다.

- 입력: `{ course_id?: number, force?: boolean = false }`
- 출력: `{ ok, synced: [CourseMetadataRecord], errors }`
- `CourseMetadataRecord.source`는 둘 중 하나다 (live 검증 2026-06-13 — `docs/DISCOVERY.md` 참고):
  - `learningx_sis`: SIS 조회 성공. `course_code(학수번호) / section / term`은 LearningX
    `sis_source_id`(`{년도}_{학기}_{캠퍼스}_{학과코드}_{학수번호}_{분반}`) 구조 파싱으로 얻은 확정값이다.
    `term`도 SIS 형식(`"2026-1"`)으로 통일된다(Canvas `"2026년 1학기"`는 폴백).
  - `canvas_only`: SIS 조회 실패. `course_code/section`은 `null`이고 `sis_error`에 원인이 들어간다.
    `term`은 Canvas `term.name`(`"2026년 1학기"`)을 유지한다.
- source와 무관하게 Canvas 사실값을 채운다: `college / department`는 `account.name`
  (`"{단과대} {학부}"` 형태, include[]=account) 파싱, `instructor`는 `teachers[0].display_name`,
  `canvas_account_name`에는 account 이름 원문을 보존한다. 교양과목은 `account.name`이 `"대학(전체)"`라
  교양대학으로 명시 매핑되어 `ge_notice`로 라우팅된다. 그 외 단과대 파싱이
  안 되면 college/department는 `null`이고 호출자 LLM이 `canvas_account_name`/`canvas_course_code`
  등 원본 필드로 직접 판단한다.
- 사용 시점: `eclass_get_exam_schedule`를 `course_id`로 쓰기 전. 조회 도구도 필요한 경우 자동으로 1회 동기화한다.

### eclass_sync_exam_schedules

기말고사 공지 소스를 확인하고 PDF 시간표를 다운로드/정규화해 시험 DB에 저장한다.

- 입력: `{ term: string, exam_type?: 'final' = 'final', course_id?: number, force?: boolean = false, source_url?: string }`
- 출력: `{ ok, term, exam_type, sources_checked, documents, partial_failures }`
- 동작:
  - `source_url`이 있으면 해당 공지만 처리한다.
  - 없으면 중앙대 대학 목록에서 단과대 후보를 갱신하고, 교양대학/소프트웨어대학 전용 어댑터를 우선 사용한다.
  - PDF 해시와 공지 본문 해시가 이전과 같고 `force=false`면 재파싱을 건너뛴다.
  - `pdftotext -tsv`가 없거나 PDF가 스캔본이면 문서 정보는 남기고 `partial_failures`에 `EXAM_PARSER_UNAVAILABLE` 또는 `EXAM_PARSER_UNSUPPORTED`를 기록한다.

### eclass_get_exam_schedule

저장된 시험 시간표를 로컬 DB에서 조회한다. 평소 조회는 네트워크를 쓰지 않는다.

- 입력: `{ course_id?: number, query?: string, term?: string, exam_type?: 'final' = 'final', refresh?: boolean = false }`
- 출력(성공): `{ ok: true, mode, matches, matched_by?, refresh_result? }`
  - `matched_by`: `"exact"`(course_code+section) 또는 `"name_section"`(교양 fallback).
- 출력(실패): `{ ok: false, mode, reason, course_metadata?, candidates, refresh_result? }`
- 매칭 규칙(v2): `course_id` 지정 시 SIS 확정 `course_code + section` **exact match**를 우선 수행한다. fuzzy matching·confidence는 제거됐다.
  - **교양대학 fallback**: `college === "교양대학"`인 과목은 교양 PDF에 `course_code`가 없어 exact match가 구조적으로 불가능하다. 이 경우에만 **강의명 + 분반(정규화)** 으로 매칭하고 `matched_by: "name_section"`을 단다. 정규화는 강의명 끝의 `NN분반` 표기·공백 제거와 분반 leading zero(`"2"=="02"`) 무시를 포함한다. 그 외 단과대(및 `canvas_only` 미확정)는 오매칭 위험이 있어 fallback하지 않는다.
  - exact·fallback 모두 실패 시 `reason: "EXACT_MATCH_NOT_FOUND"`와 함께 해당 `term + exam_type`의 전체 schedule row 목록을 `candidates`로 반환한다. 호출자 LLM이 후보를 보고 직접 판단한다.
  - `course_metadata`에는 매칭에 쓴 확정값과 `source`/`sis_error`/Canvas 원본 필드가 들어 있다.
  - 기타 reason: `COURSE_METADATA_NOT_FOUND`(메타데이터 미동기화), `REFRESH_REQUIRES_TERM`, `NO_SCHEDULES`.
- `query`만 주면 강의명/과목코드/교수명 LIKE 필터로 목록을 반환한다(추론 없음).
- `refresh=true`를 쓰면 `term`이 필요하며, 먼저 `eclass_sync_exam_schedules`를 실행한 뒤 조회한다.
- 파서가 깨진 것으로 의심되면 `eclass_list_exam_sources`로 `last_status`/`last_error`를 확인하고 `docs/SELF_REPAIR.md` 절차를 따른다.

### eclass_list_exam_sources

시험 공지 소스 목록과 마지막 동기화 상태를 조회한다.

- 입력: `{ refresh?: boolean = false }`
- 출력: `{ ok, sources, partial_failures }`
- `refresh=true`면 중앙대 대학 목록 페이지에서 단과대 후보를 다시 수집한다.

### eclass_search_syllabus

CAU mportal2에서 교과목계획서(syllabus)를 검색한다. 과목명 또는 교수명으로 검색한 후보 목록을 그대로 반환하며, 매칭 판단은 하지 않는다 (호출자 LLM이 후보 중 선택).

- 입력: `{ year?: string, term?: string, query: string, by?: 'subject'|'professor' = 'subject' }`
  - `year`: 개설년도 (예: `"2026"`). 생략 시 현재 학기 기준으로 추정.
  - `term`: 학기 코드 (`1`/`2`/`S`/`W`). 생략 시 현재 학기 기준으로 추정.
  - `query`: 필수. 과목명 또는 교수명.
  - `by`: `'subject'`(과목명, 기본) 또는 `'professor'`(교수명).
- 출력(성공): `{ ok: true, items: SyllabusSearchItem[] }`
  - `SyllabusSearchItem`: `{ year, term, campus_code, course_code(학수번호), section(분반), course_no_full, course_name, sust_code, college, department, classification, professor, time_room, has_file }`
- 출력(실패): `{ ok: false, error_code, message }`
  - 주요 코드: `SYLLABUS_SEARCH_FAILED`, `SYLLABUS_TERM_UNRESOLVED`.
- 사용 시점: 학기 중 상시. "OO 과목 교재가 뭐야?" 같은 질문에 검색 후 `eclass_get_syllabus`로 상세 조회. 시험 시간표 매칭에 필요한 학수번호·분반 확인용으로도 활용 가능.

### eclass_get_syllabus

특정 강의 1개의 구조화된 교과목계획서를 반환한다. `eclass_search_syllabus` 결과 행의 필드를 그대로 전달하는 것을 권장한다.

- 입력: `{ year: string, term: string, sbjtno1: string(학수번호), clssno1: string(분반), campcd?: string, sust?: string }`
  - `year`/`term`/`sbjtno1`/`clssno1`은 필수.
- 출력(성공): `{ ok: true, document: SyllabusDocument }`
  - `SyllabusDocument`:
    - `basic`: `{ year, term, campus, course_code, section, credit, title_ko, title_en, time_room, classification, lecture_type, course_type, medium, college, department, eclass_usage }`
    - `instructor`: `{ name, email, office_phone, contact, office_hour, office_location, homepage }`
    - `objectives`: `{ description, prerequisites, learning_objectives, learning_outcomes }`
    - `textbooks[]`
    - `assessment[]`: `{ item, ratio, description }`
    - `schedule[]`: `{ week, instructor, topic, ... }`
    - `raw_text`: 항상 포함됨. `pdftotext -layout`로 추출한 전체 텍스트(표 구조 보존). **구조화 필드가 누락·부정확할 때 1차 폴백** — 특히 교재 출판사/판차나 제목이 긴 경우 컬럼 충돌로 어긋날 수 있으니 `raw_text`로 확인.
- 출력(실패): `{ ok: false, error_code, message }`
  - 주요 코드: `SYLLABUS_OZ_UNAVAILABLE`(OZ 리포트 서버 응답 실패), `SYLLABUS_PARSER_UNAVAILABLE`(`pdftotext` 없음), `SYLLABUS_EXTRACT_FAILED`.
- **파싱 방식**: OZ PDF를 `pdftotext`로 **두 번** 추출한다 — 기본(reading-order)은 기본정보·교수·평가·과목설명 등 scalar 필드용, `-layout`은 2-D 표(교재·주차일정)를 컬럼 위치 기반으로 분리하는 데 사용한다. 표는 헤더에서 컬럼 시작 위치를 잡고 행을 앵커(주차번호/교재종류)로 분할해 래핑된 셀을 병합한다. 추출 불가/모호한 값은 라벨을 흘리지 않고 `null` 처리(정직한 폴백), 전체 원문은 `raw_text`가 보장한다.
- **의존성**: CAU OZ 리포트 서버에서 PDF로 받아 `pdftotext`(poppler)로 파싱한다. macOS는 `brew install poppler`로 설치 필요 — 설치되어 있지 않으면 `SYLLABUS_PARSER_UNAVAILABLE`을 반환한다.

### eclass_search_downloads

로컬에 다운로드된 파일 검색. **네트워크 호출 없음** (로컬 캐시 DB만).

- 입력: `{ course_id?, query?, extension?, downloaded_after?, downloaded_before?, limit?=50 }`
  - `query`: 파일명 또는 강의명 부분 일치 (대소문자 무시).
  - `extension`: `"pdf"` 또는 `".pdf"` 둘 다 허용.
  - `source`: 자료 출처(modules/files/courseresource 등). **source가 기록된 레코드만** 매칭됨 (구버전 다운로드 기록은 source가 null).
  - 날짜 범위는 ISO 문자열, 양끝 포함. 파싱 불가한 값은 무시.
- 출력: `{ matches: [DownloadRecord + { course_name, extension }], total_matched, limit }` — 최신순 정렬, limit 적용 전 총 개수는 `total_matched`.

### eclass_export_course_snapshot

한 강의의 현재 상태를 JSON/Markdown으로 내보내기. 기존 read 툴들을 조합한다.

- 입력: `{ course_id: number, format?: 'json'|'markdown' = 'json', include_grades?: boolean = false, output_path?: string, overwrite?: boolean = false }`
- 출력: `{ ok, course_id, format, local_path?, snapshot?, content?, partial_failures: [{ section, reason }] }`
  - `output_path` 지정 시 파일로 저장하고 `local_path` 반환. 미지정 시 json은 `snapshot`, markdown은 `content`로 직접 반환.
  - `output_path`에 기존 파일이 있으면 기본적으로 거부한다 (`SNAPSHOT_OUTPUT_EXISTS`). 덮어쓰려면 `overwrite: true`를 명시.
  - 포함 내용: 강의 정보, 과제, 공지, 자료, 다운로드 현황, (옵션) 성적.
  - 일부 섹션 수집 실패해도 나머지는 포함하고 `partial_failures`에 기록 (예: Playwright 자료 소스 실패는 `materials:courseresource`).

### eclass_get_announcements

강의 공지사항.

- 입력: `{ course_id: number, limit?: number = 20 }`
- 출력: `[{ id, title, author, posted_at, message, has_attachment }]` — message는 HTML 제거된 텍스트.

### eclass_get_materials

강의 자료 목록. 여러 source를 병렬 수집하며 일부 실패해도 성공분은 반환 (partial success).

- 입력: `{ course_id: number, sources?: ('modules'|'files'|'courseresource'|'external'|'modulebuilder'|'announcements')[] }`
  - sources 생략 시 전부 조회. `courseresource`는 LearningX HTTP/API를 먼저 시도하고 실패 시 Playwright 인터셉트로 폴백한다. `modulebuilder`는 아직 Playwright를 사용한다.
- 출력: `{ ok, course_id, sources: { requested, succeeded, failed }, materials, errors, warnings }`
  - material: `{ id, title, type, url, source, module_name?, is_playright_required?, is_downloaded?, local_path? }`
  - 동영상 자료는 `type`이 `mp4`/`video/*` 계열이고 `url`이 `https://ocs.cau.ac.kr/em/...` 형태일 수 있다. 다운로드는 파일 도구가 아니라 `eclass_download_video`를 사용한다.
  - `is_downloaded: true`면 이미 로컬에 있음 (`local_path` 참조) — 재다운로드 불필요.
- `ok: false`는 모든 source 실패. `errors[].retryable`이 true면 재시도 가치 있음.

### eclass_download_file

파일 1개 다운로드. `eclass_get_materials` 결과 중 비동영상 파일 항목을 넘긴다.

- 입력: `{ file_id: string, course_id: number, url: string | null, display_name: string, type?: string }`
  - `url`이 null이거나 `ocs.cau.ac.kr/em/` 뷰어 URL이면 Playwright 경로로 자동 처리.
  - `type`이 영상 계열(mp4/m3u8/video 등)이면 파일 도구에서 거부된다. OCS MP4 동영상은 `eclass_download_video`를 사용한다.
- 출력: `{ file_id, display_name, local_path, size_bytes, skipped }` — `skipped: true`면 캐시 히트로 다운로드 생략.
- 저장 위치: `~/Downloads/eclass/{course_id}/` (env `ECLASS_DOWNLOAD_DIR`로 변경 가능).
- 내부적으로 url/type에 따라 DownloadStrategy를 결정한다 (아래 "다운로드 전략" 참조).

### eclass_download_materials_batch

여러 파일 자료를 한 번에 다운로드. **부분 성공** 지원 — 일부 실패해도 나머지는 계속 진행한다. 동영상은 제외하고 `eclass_download_video`로 별도 처리한다.

- 입력: `{ course_id: number, materials: [{ file_id, url?, display_name, type?, source? }], continue_on_error?: boolean = true }`
  - `continue_on_error: false`면 첫 실패에서 중단.
  - 다운로드는 순차 처리 (eclass 부담·공유 Playwright 세션 안정성 때문).
  - 영상 계열 type은 실패 항목으로 반환되며 `eclass_download_video` 사용을 안내한다.
- 출력: `{ ok, course_id, summary: { total, downloaded, skipped, failed }, results: [DownloadOutcome] }`
  - DownloadOutcome: `{ file_id, display_name, status: 'downloaded'|'skipped'|'failed', strategy, local_path?, size_bytes?, error_code?, message?, retryable? }`
  - `ok: false`는 실패 항목이 하나라도 있음을 의미.
- `source`를 넘기면 캐시 DB에 기록되어 이후 `eclass_search_downloads`의 source 필터로 검색 가능.

### eclass_download_video

OCS UniPlayer MP4 동영상을 검증 후 다운로드한다. 기존 파일 다운로드 도구와 분리된 동영상 전용 툴이다.

- 입력: `{ video_id: string, course_id: number, url: string, display_name: string, type?: string, source?: string }`
  - `video_id`: material id 또는 동영상 식별자. 캐시에는 파일 기록과의 충돌을 막기 위해 `video:<video_id>` 키로 저장된다 (`eclass_list_downloads`/`eclass_remove_download`에서 이 키로 보인다).
  - `url`: `https://ocs.cau.ac.kr/em/<content_id>` 형식만 지원.
  - `display_name`: 저장 파일명. 확장자가 없으면 `.mp4`를 붙인다.
  - `source`: 자료 출처. 캐시에 기록되어 `eclass_search_downloads`에서 source 필터로 찾을 수 있다.
- 출력(성공): `{ ok: true, video_id, display_name, local_path, size_bytes, skipped, strategy: 'ocs_uniplayer_mp4' }`
- 출력(실패): `{ ok: false, error_code, message, retryable, next_action?, debug? }`
  - `VIDEO_DOWNLOAD_UNSUPPORTED`(미지원 형식 — 재시도 무의미)와 `VIDEO_DOWNLOAD_FAILED`(일시적 네트워크/CDN 장애 — `retryable` 참조)를 구분한다.
- 지원 범위:
  - OCS metadata의 `main_media`가 MP4 파일명인 UniPlayer 콘텐츠만 지원.
  - CDN MP4 후보를 만든 뒤 Range probe로 `video/mp4`와 MP4 signature를 확인한 경우에만 다운로드한다 (CDN이 Range를 무시해도 앞 16바이트만 읽는다).
  - 본문은 메모리 버퍼링 없이 `<파일명>.part` 임시 파일로 스트리밍한 뒤 완료 시 rename — 부분 파일이 정식 경로에 남지 않는다.
  - CDN 요청에는 Canvas/LearningX 인증 정보를 보내지 않는다.
- 미지원:
  - HLS/m3u8, DRM/encrypted media, segment stream, 진도/출석 추적 이벤트 우회.
  - 비디오가 아닌 파일 자료는 `eclass_download_file` 또는 `eclass_download_materials_batch`를 사용한다.

### eclass_list_downloads

다운로드 기록 원본 목록.

- 입력: `{ course_id?: number }`
- 출력: `[{ file_id, course_id, display_name, local_path, downloaded_at, size_bytes }]`

### eclass_get_download_status

다운로드 현황 요약. 로컬 DB만 사용 (네트워크 없음).

- 입력: `{ course_id?: number }`
- 출력: course_id 없으면 `{ mode: 'summary', courses: [...], total_file_count, total_size_bytes }`, 있으면 `{ mode: 'detail', downloads: [...], ... }`

### eclass_remove_download

다운로드 기록 삭제 (재다운로드 허용 목적). 디스크 파일은 지우지 않음.

- 입력: `{ file_id?: string, course_id?: number }` — 둘 중 하나 필수.
- 출력: `{ removed, file_id }` 또는 `{ removed: count, course_id }`

### eclass_file_handoff

다운로드된 파일을 클라이언트에 전달한다. **두 가지 모드**가 있으며 transport에 따라 자동 선택된다.

- **URL 모드 (HTTP transport, ChatGPT 커넥터)**: base64를 컨텍스트에 싣지 않고 **다운로드 URL만 텍스트로** 반환한다. URL은 HTTP 서버의 `GET /files/<token>` 엔드포인트를 가리키며, 같은 머신의 브라우저가 localhost로 직접 받는다(터널은 `/mcp`만 포워딩하므로 외부에서는 접근 불가 — 헤드리스/원격 호스트는 `ECLASS_HANDOFF_BASE_URL`로 도달 가능한 주소를 지정). 토큰은 1회 발급되는 불투명 값으로 그 자체가 자격증명이며 일정 시간 후 만료된다. 큰 파일도 메모리/컨텍스트에 올리지 않는다.
- **blob 모드 (stdio transport, 로컬)**: 파일 바이트를 MCP embedded resource blob(base64)으로 반환한다. ⚠️ base64가 응답 본문(=대화 컨텍스트)에 그대로 포함되므로 큰 파일은 컨텍스트를 빠르게 소모한다.

- 입력: `{ file_id: string }`
  - `file_id`: `eclass_search_downloads`/`eclass_list_downloads`가 반환하는 file_id. 영상은 `video:<id>`.
- 출력(성공, URL 모드): `structuredContent = { file_id, display_name, mime_type, size_bytes, delivered: true, download_url }` + `content[0] = { type: "text", text: "...링크..." }`
- 출력(성공, blob 모드): `structuredContent = { file_id, display_name, mime_type, size_bytes, delivered: true }` + `content[0] = { type: "resource", resource: { uri: "file:///<파일명>", mimeType, blob } }`
- 출력(실패, `isError`): `not_found`(file_id 없음) / `file_missing`(레코드는 있으나 디스크 파일 없음) / `too_large`(`ECLASS_HANDOFF_MAX_BYTES` 초과, 기본 25MB)
- 청킹 미지원 — 한계 초과 파일은 거절한다(URL 모드는 한계 검사만 하고 바이트는 안 읽는다).

## 다운로드 전략 (DownloadStrategy)

`eclass_download_file`/`eclass_download_materials_batch`는 항목의 `url`/`type`을 보고 처리 방식을 자동 결정한다 (`src/download-strategy.ts`):

| strategy | 조건 | 처리 |
|---|---|---|
| `already_cached` | 캐시 히트 (file_id, 또는 파일명+크기+존재) | 다운로드 생략 (skipped) |
| `unsupported_streaming_media` | 파일 다운로드 도구에 type이 mp4/m3u8/video 등으로 들어옴 | 실패 처리 (`DOWNLOAD_UNSUPPORTED_MEDIA`), `eclass_download_video` 안내 |
| `ocs_intercept` | url이 `ocs.cau.ac.kr/em/` 뷰어 | Playwright로 파일 응답 인터셉트 |
| `playwright_ui` | url 없음 (courseresource) | Playwright LTI 경로 |
| `canvas_file` | url이 `eclass3.cau.ac.kr` | 토큰으로 직접 fetch (리다이렉트 추적) |
| `direct_url` | 그 외 허용 origin | 직접 fetch |

동영상 다운로드는 위 파일 DownloadStrategy와 별개로 `eclass_download_video`에서 `ocs_uniplayer_mp4` 전략을 사용한다.

캐시 검증은 `file_id` → (`course_id`+파일명+크기+디스크 존재) 순으로 확인하며, 파일명·크기가 같으면 새 `file_id`를 같은 파일에 재연결한다.

## 자주 쓰는 조합 흐름

- **새 파일 자료 받기**: `eclass_get_courses_cached` → course_id 선택 → `eclass_get_materials` → 동영상이 아닌 `is_downloaded: false` 항목들을 `eclass_download_materials_batch`에 한 번에 넘김 (각 material의 `source`도 같이 넘기면 검색에 활용됨).
- **동영상 받기**: `eclass_get_materials`에서 `type`이 mp4/video 계열이고 `url`이 `https://ocs.cau.ac.kr/em/...`인 항목 선택 → `eclass_download_video`.
- **마감 임박 과제 확인**: `eclass_get_assignments { days_ahead: 7, include_submitted: false }`.
- **문제 진단**: 툴 오류 발생 → `eclass_doctor` → 실패 check의 detail로 원인 판단 (인증이면 `npm run setup` 재실행 안내).
- **성적 확인**: `eclass_get_grades`(전체) 또는 `eclass_get_grades { course_id }`(특정 강의 + 과제별 점수).
- **과제 제출 준비**: `eclass_get_assignments`로 대상 과제 파악 → `eclass_get_assignment_detail`로 `submission_types`/`allowed_extensions`/마감 확인 → `eclass_submit_assignment`를 먼저 `dry_run: true`로 호출.
- **강의 백업/요약**: `eclass_export_course_snapshot { course_id, format: 'markdown', output_path }`.

## 환경 변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `ECLASS_USERNAME` | (필수) | eclass 로그인 ID |
| `ECLASS_DOWNLOAD_DIR` | `~/Downloads/eclass` | 다운로드 저장 위치 |
| `ECLASS_DB_PATH` | `~/.eclass-mcp/files.db` | 다운로드/강의 캐시 DB |
| `ECLASS_HANDOFF_MAX_BYTES` | `26214400` | `eclass_file_handoff`가 전달할 파일의 최대 크기(바이트). 기본 25MB |
| `ECLASS_HANDOFF_BASE_URL` | `http://127.0.0.1:<port>` | URL 모드(HTTP transport) handoff 링크의 base. 헤드리스/원격 호스트에서 사용자가 도달 가능한 주소로 덮어쓴다 |
| `ECLASS_CREDENTIAL_BACKEND` | auto | `encrypted` / `keytar` / `file` 강제. auto는 마스터 키 있으면 encrypted, 아니면 keytar, 둘 다 없으면 file |
| `ECLASS_SECRET_KEY` | (없음) | 암호화 백엔드 마스터 키(32바이트 base64). 헤드리스 서버 실행 시 주입 |
| `ECLASS_SECRET_KEY_FILE` | (없음) | 마스터 키 파일 경로(raw 32바이트 또는 base64 텍스트) |
| `ECLASS_ENC_STORE_PATH` | `~/.eclass-mcp/secrets.enc` | 암호화 비밀번호 파일 경로 |
| `ALLOW_PLAINTEXT_ENV_SECRETS` | 꺼짐 | `1`일 때만 `ECLASS_PASSWORD` env 허용 |
| `CONTROL_PLANE_API_KEY` | — | OpenAI tunnel 런타임 API 키 (Tunnels Read+Use). `npm run chatgptui`에서 사용 |
| `CONTROL_PLANE_TUNNEL_ID` | — | tunnel 식별자 (Platform Tunnels 발급) |
| `ECLASS_TUNNEL_PROFILE_FILE` | `${XDG_CONFIG_HOME:-~/.config}/tunnel-client/eclass-mcp.yaml` | tunnel-client 프로파일 경로 오버라이드 |
| `DEBUG` | 꺼짐 | `1`이면 stderr 디버그 로그 |
