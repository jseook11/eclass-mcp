# SELF_REPAIR — 시험 일정 파이프라인 자가 수리 지침서

이 문서는 단과대 홈페이지 HTML 변경 등으로 시험 일정 파서가 깨졌을 때,
MCP를 사용하는 에이전트가 스스로 원인을 찾고 고치기 위한 지침서다.

## 1. 파이프라인 개요

```text
source discovery            src/tools/exams/notice-sources.ts (BUILTIN_EXAM_SOURCES, discoverExamSources)
→ notice HTML fetch         fetchNoticeDocument → fetchText
→ notice HTML parsing       parseNoticeHtml → adapter_type switch (ge_notice / cse_notice / generic)
→ PDF download              downloadNoticePdf (attachment_url → %PDF magic 검증)
→ pdftotext -tsv            src/tools/exams/pdf-parser.ts parseExamPdf
→ coordinate row parsing    parseExamScheduleTsv → layout별 컬럼 x좌표 범위
→ row normalization         parseSoftwareLine / parseGeneralEducationLine
→ SQLite 저장               src/exam-cache.ts (~/.eclass-mcp/exams.db)
→ MCP query                 eclass_get_exam_schedule (course_code+section exact match)
```

course metadata는 별도 경로다:

```text
Canvas /api/v1/courses → LearningX LTI launch (xn_api_token)
→ SIS endpoint (src/learningx-client.ts fetchSisCourseInfo)
→ normalizeSisCourseInfo → course_metadata (source: learningx_sis | canvas_only)
```

## 2. 진단표

| 증상 | 가능 원인 | 확인 위치 | 다음 행동 |
| --- | --- | --- | --- |
| source는 있는데 schedule이 비어 있음 | HTML parser 실패 | `exam_sources.last_error` | 원본 HTML 확보 후 fixture 갱신 |
| `last_status = no_exam_document` | 공지 글이 내려갔거나 selector 변경 | `parseNoticeHtml` adapter | HTML에서 제목/첨부 구조 확인 |
| PDF 다운로드 실패 | 첨부 링크 selector 변경 | parser adapter (`parse*NoticeHtml`) | HTML에서 첨부 링크 구조 확인 |
| PDF는 받았는데 row가 없음 | `pdftotext -tsv` layout 변경 | `pdf-parser.ts` (x좌표 범위) | TSV fixture 확인, 좌표 재측정 |
| `EXAM_PARSER_UNAVAILABLE` | poppler 미설치 | `pdftotext -v` | `brew install poppler` |
| 특정 과목만 매칭 실패 | `course_code + section` 불일치 | `course_metadata` / `exam_schedules` rows | `candidates` 목록 확인, SIS 재동기화 |
| `source = canvas_only`만 저장됨 | LearningX SIS endpoint 변경/실패 | `course_metadata.sis_error` | `discover.ts learningx <course_id>` probe |

확인 방법:

- `exam_sources.last_error`: `eclass_list_exam_sources` 호출 결과의 `sources[].last_error` /
  `last_status` 필드. 직접 보려면 `sqlite3 ~/.eclass-mcp/exams.db 'SELECT college, last_status, last_error FROM exam_sources'`.
- `eclass_list_exam_sources`: `refresh=true`로 중앙대 단과대 목록에서 소스 후보를 재탐색할 수 있다.
- SIS 실패 원인: `eclass_sync_course_metadata` 응답의 `sis_error`, 또는
  `pnpm exec tsx scripts/discover.ts learningx <course_id>` 로 endpoint별 status/body를 직접 확인.
- 검증은 항상 `pnpm test && pnpm build` 둘 다 통과해야 한다.

## 3. 수리 절차

1. `curl` 또는 브라우저로 원본 HTML 확보: `curl -A 'eclass-mcp/0.1 exam-schedule-sync' '<notice_board_url>'`
2. 기존 fixture(테스트 내 HTML 문자열 또는 `test/fixtures/`)와 비교해 무엇이 바뀌었는지 확인
3. parser가 가정하는 DOM 구조 확인 (`parse{College}NoticeHtml`의 정규식이 기대하는 태그/클래스)
4. selector / regex 수정 — 기존 `adapter_type` switch 구조는 유지
5. fixture 갱신 (실제 HTML 조각을 반영)
6. parser 테스트 실행: `pnpm exec tsx --test test/exams.test.ts`
7. 전체 테스트 실행: `pnpm test`
8. build 실행: `pnpm build`

PDF layout이 깨진 경우(증상: row 0건, `EXAM_PARSER_UNSUPPORTED`):

1. `pdftotext -tsv <pdf> -` 로 TSV를 직접 출력
2. 헤더 행(교과목코드/분반/교과목명 등)의 `left` 좌표를 읽어 컬럼 경계를 재측정
3. `pdf-parser.ts`의 `wordsInRange(line, minX, maxX)` 범위를 수정
4. 테스트의 `word(page, left, top, text)` fixture를 실제 좌표로 갱신

## 4. 새 단과대 adapter 추가 체크리스트

- [ ] source URL 확인 (단과대 학사공지 게시판, 시험 시간표 공지 글)
- [ ] pagination 필요 여부 확인 (목록 페이지에서 글을 찾아야 하는지, 고정 URL인지)
- [ ] notice title selector 확인
- [ ] notice detail URL selector 확인 (목록 → 상세 진입이 필요한 경우)
- [ ] attachment URL selector 확인 (`onclick` 핸들러 기반이면 인자 조합 규칙 포함)
- [ ] PDF link absolute URL 변환 확인 (`absoluteUrl(noticeUrl, href)`)
- [ ] fixture 저장 (실제 공지 HTML 조각)
- [ ] parser test 추가 (`test/exams.test.ts`의 기존 패턴 유지)
- [ ] `BUILTIN_EXAM_SOURCES` 등록 (`adapter_type` 추가 + `parseNoticeHtml` switch 갱신)
- [ ] `docs/TOOLS.md` 반영

주의: 실제 수강 과목의 단과대만 전용 parser를 만든다. 단과대 이름은 Canvas
`include[]=account` 기반으로 `course_metadata.college`에 채워진다(`docs/DISCOVERY.md` 참고).
`SELECT DISTINCT college, canvas_account_name FROM course_metadata`로 수강 단과대를 확정한 뒤,
전용 parser가 없는 곳에만 추가한다. college가 null인 과목("대학(전체)" 교양 등)은
notice source 선택이 전체 소스 fallback으로 동작한다.
generic parser(`parseGenericNoticeHtml`)를 무리하게 복잡하게 만들지 말 것.
