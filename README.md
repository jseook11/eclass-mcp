# eclass-mcp

중앙대학교 eclass(LearningX / Canvas LMS)를 Claude·Codex 등 MCP 클라이언트에서
자연어로 다루게 해주는 **MCP 서버**입니다. 강의·과제·성적 조회부터 자료/동영상
다운로드, 과제 제출, **기말시험 시간표 조회**, **강의계획서(syllabus) 검색·조회**까지
LMS 작업을 도구로 노출합니다.

인증(Keychain 토큰 캐시 → 만료 시 Playwright 자동 로그인)과 타임아웃·재시도는
서버가 알아서 처리하므로, 클라이언트는 "이번 학기 시험 언제 봐?", "마감 임박 과제
알려줘" 같은 요청만 던지면 됩니다.

> ⚠️ 개인 학습·편의용 비공식 도구입니다. 본인 계정으로만 사용하세요.

## 주요 기능

MCP 도구로 노출되는 대표 기능들 (전체 명세는 [`docs/TOOLS.md`](docs/TOOLS.md)):

| 영역 | 할 수 있는 것 | 핵심 도구 |
|---|---|---|
| 강의 | 수강 목록 조회 (로컬 캐시 우선) | `eclass_get_courses`, `eclass_get_courses_cached` |
| 과제 | 마감 임박 과제·퀴즈 조회, 상세(제출 유형/확장자/마감) 확인 | `eclass_get_assignments`, `eclass_get_assignment_detail` |
| 과제 제출 | 파일/텍스트 제출 (기본 `dry_run`, 이중 제출 방지 검증) | `eclass_submit_assignment` |
| 성적 | 강의 단위 + 과제별 점수 | `eclass_get_grades` |
| 자료 | 강의 자료 목록 수집, 파일 일괄 다운로드 | `eclass_get_materials`, `eclass_download_materials_batch` |
| 동영상 | OCS UniPlayer MP4 동영상 다운로드 | `eclass_download_video` |
| 시험 시간표 | 기말시험 공지 PDF 파싱 → `course_id`로 시험 일시·장소 조회 | `eclass_sync_exam_schedules`, `eclass_get_exam_schedule` |
| 강의계획서 | 과목명/교수명으로 검색 → OZ 리포트 PDF를 구조화(교재·평가·주차일정) 조회 | `eclass_search_syllabus`, `eclass_get_syllabus` |
| 백업 | 강의 스냅샷을 JSON/Markdown으로 내보내기 | `eclass_export_course_snapshot` |
| 진단 | 인증·브라우저·API 사전 점검 | `eclass_doctor` |

시험 시간표는 단과대 공지(예: 소프트웨어대학)는 학수번호+분반 exact match로,
**교양대학 과목**은 강의명+분반 정규화 매칭으로 잡습니다(`matched_by`로 구분).

강의계획서는 CAU 포털(mportal2)+OZ 리포트 서버에서 받아오며, "OO 과목 교재 보통
뭐 써?" 같은 질문에 **학기와 무관하게** 답할 수 있습니다. PDF를 `pdftotext`로
파싱해 교재·평가비율·주차별 주제를 구조화하고, 원문 전체를 `raw_text`로도 제공합니다.

## 요구 사항

- **Node.js 24.x** (`engines`로 강제 — `preinstall`에서 버전 확인)
- **pnpm**
- **OS credential store**: macOS Keychain / Linux Secret Service(libsecret) — LMS 비밀번호 저장용
- **Playwright Chromium**: 자동 로그인·일부 자료 인터셉트용 (`postinstall`에서 자동 설치)
- **pdftotext**(poppler): 시험 시간표·강의계획서 PDF 파싱용. 없으면 시험 동기화가
  `partial_failures`에 `EXAM_PARSER_UNAVAILABLE`을, 강의계획서 조회가
  `SYLLABUS_PARSER_UNAVAILABLE`을 남기고 다른 기능은 정상 동작합니다.
  - macOS: `brew install poppler`

## 설치

```bash
pnpm install      # 의존성 설치 + better-sqlite3 rebuild + Chromium 설치(postinstall)
pnpm run build    # TypeScript → dist/ (MCP 서버는 node dist/index.js로 실행됨)
```

## 셋업

대화형 셋업 스크립트가 자격 증명을 저장하고 MCP 클라이언트 설정 파일을 자동으로 써줍니다.

```bash
pnpm run setup
```

- ID/비밀번호를 입력하면 비밀번호는 **OS credential store**에 저장됩니다(설정 파일에 평문으로 남지 않음).
- 설정 대상은 자동 감지하거나 `--target`으로 지정합니다:
  - `--target mcp-json` → 프로젝트의 `.mcp.json` (Claude Code 등)
  - `--target hermes` → Hermes config
  - `--target both`
- 셋업 끝에 `doctor` 점검이 돌며 인증·brower·API 상태를 확인합니다. (`--no-doctor`로 생략)

생성되는 MCP 서버 항목은 다음 형태입니다 (`node`로 직접 실행 — `pnpm start`는 배너가
JSON-RPC를 오염시키므로 쓰지 않습니다):

```jsonc
{
  "mcpServers": {
    "eclass": {
      "command": "node",
      "args": ["<repo>/dist/index.js"],
      "env": { "ECLASS_USERNAME": "<your-id>" }
    }
  }
}
```

설정 후 MCP 클라이언트를 재시작(또는 재연결)하면 도구가 노출됩니다.

## 사용 예시

MCP 클라이언트에서 자연어로 요청하면 서버가 도구를 조합해 처리합니다.

- "이번 학기 기말시험 언제 어디서 보는지 정리해줘" → 시험 동기화 후 `course_id`별 조회
- "이번 주 마감 과제만 보여줘" → `eclass_get_assignments { days_ahead: 7, include_submitted: false }`
- "운영체제 강의 자료 안 받은 거 다 받아줘" → `eclass_get_materials` → `eclass_download_materials_batch`
- "이 과제 제출 가능한지 먼저 확인해줘" → `eclass_get_assignment_detail` → `dry_run` 제출
- "운영체제 교재 보통 뭐 써?" → `eclass_search_syllabus` → `eclass_get_syllabus`로 교재 확인

자주 쓰는 도구 조합 흐름은 [`docs/TOOLS.md`의 "자주 쓰는 조합 흐름"](docs/TOOLS.md#자주-쓰는-조합-흐름) 참고.

## 환경 변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `ECLASS_USERNAME` | (필수) | eclass 로그인 ID |
| `ECLASS_DOWNLOAD_DIR` | `~/Downloads/eclass` | 다운로드 저장 위치 |
| `ECLASS_DB_PATH` | `~/.eclass-mcp/files.db` | 다운로드/강의 캐시 DB |
| `ECLASS_EXAM_DB_PATH` | `~/.eclass-mcp/exams.db` | 시험 시간표 전용 DB |
| `ECLASS_CREDENTIAL_BACKEND` | keytar (가능 시) | `file` 지정 시 파일 저장소 강제 |
| `ALLOW_PLAINTEXT_ENV_SECRETS` | 꺼짐 | `1`일 때만 `ECLASS_PASSWORD` env 허용 |
| `DEBUG` | 꺼짐 | `1`이면 stderr 디버그 로그 |

## 개발

```bash
pnpm run dev      # tsx로 소스 직접 실행
pnpm test         # node --test 기반 테스트
pnpm run build    # 타입체크 겸 빌드
pnpm run doctor   # 인증/브라우저/API 사전 점검
pnpm run discover # 엔드포인트 디스커버리 (docs/DISCOVERY.md)
```

## 문서

- [`docs/TOOLS.md`](docs/TOOLS.md) — 전체 도구 명세 및 사용 흐름
- [`docs/DISCOVERY.md`](docs/DISCOVERY.md) — eclass API 엔드포인트 디스커버리
- [`docs/SELF_REPAIR.md`](docs/SELF_REPAIR.md) — 시험 파서 등 자가 점검·복구 절차
