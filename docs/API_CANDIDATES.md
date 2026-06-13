# API 전환 후보 메모

이 문서는 현재 MCP 구현 중 Playwright/UI 의존을 줄이고 API 호출로 대체할 수 있는 후보를 정리한 메모다.
2026-06-12 라이브 디스커버리 기준이며, 실제 토큰/쿠키/verifier 값은 기록하지 않는다.

## 원칙

- `.env`의 `ECLASS_TOKEN`은 테스트용 probe에만 사용했다. 런타임 설계에서 토큰 우선 사용 경로로 넣지 않는다.
- Canvas REST API와 LearningX 내부 API는 인증 토큰이 다르다.
- LearningX 내부 API는 Canvas Bearer 토큰만으로는 대부분 `400 Invalid request`가 난다.
- LearningX 내부 API를 브라우저 없이 쓰려면 Canvas `sessionless_launch`로 LTI form을 얻고, HTTP로 LTI POST를 수행해 발급되는 `xn_api_token`을 `Authorization: Bearer`로 써야 한다.
- OCS는 별도 서버 API를 붙인 구조지만, UniPlayer MP4 콘텐츠는 XML metadata에서 direct CDN MP4를 찾을 수 있다. HLS/DRM/진도 추적이 얽힌 영상은 별도 판단한다.

## 이미 Canvas REST API로 충분한 영역

현재 구현도 대부분 Canvas API를 이미 사용한다.

- 강의 목록: `GET /api/v1/courses`
- 과제 상세: `GET /api/v1/courses/:course_id/assignments/:assignment_id?include[]=submission`
- 성적/과제 점수: `GET /api/v1/courses/:course_id/assignments?include[]=submission`
- 공지: `GET /api/v1/courses/:course_id/discussion_topics?only_announcements=true`
- 파일 목록: `GET /api/v1/courses/:course_id/files`
- 모듈 기본 목록: `GET /api/v1/courses/:course_id/modules?include[]=items`

## 전환 우선순위 높음

### 1. CourseResource 자료 목록

현재:

- `BrowserSession.interceptCourseresource(courseId)`
- Playwright로 `/courses/:course_id/external_tools/3` 로드
- 네트워크에서 `resources_db` 응답 인터셉트

API-only 후보:

```text
GET /api/v1/courses/:course_id/external_tools/sessionless_launch?id=3&launch_type=course_navigation
GET <sessionless_launch.url>                         # LTI form HTML
POST /learningx/lti/courseresource                   # form fields 그대로 전송
GET /learningx/api/v1/courses/:course_id/resources_db?user_login=<student_no>
```

검증 결과:

- `sessionless_launch?id=3` 200, `url` 반환 확인.
- LTI form action: `https://eclass3.cau.ac.kr/learningx/lti/courseresource`
- HTTP POST 후 cookie names: `xn_api_token`, `XSRF-TOKEN`, `laravel_session`, `NCPVPCLB`
- `xn_api_token`을 `Authorization: Bearer`로 쓰면 `resources_db` 200.
- `course_id=<course_id>` 기준 34개 반환: PDF 30개, movie/mp4 4개.
- 응답 필드: `resource_id`, `title`, `description`, `position`, `published`, `commons_content`, `submitted`
- `commons_content` 주요 필드: `content_id`, `content_type`, `view_url`, `thumbnail_url`, `progress_support`, `file_name`, `duration`

구현 제안:

- `BrowserSession`에 Playwright 대신 HTTP LTI launch helper를 추가하거나 별도 `learningx-client.ts`를 둔다.
- `fetchCourseresource`는 우선 API-only를 시도하고, 실패 시 기존 Playwright intercept로 폴백한다.
- `user_login`은 하드코딩하지 말고 `users/self` 또는 설정된 username/student number에서 얻는 경로를 명확히 둔다.

### 2. External tool ID 동적 탐색

현재:

- `external_tools/3`, `external_tools/211` 등이 코드에 하드코딩되어 있다.

API 후보:

```text
GET /api/v1/courses/:course_id/tabs
GET /api/v1/courses/:course_id/lti_apps/launch_definitions?placements[]=course_navigation&placements[]=link_selection&placements[]=assignment_view
```

검증 결과:

- `GET /api/v1/courses/<course_id>/tabs` 200.
- 확인된 tab/tool:
  - `context_external_tool_3`: 강의자료실
  - `context_external_tool_211`: 주차학습 (모듈)
  - `context_external_tool_209`: 게시판
  - `context_external_tool_210`: 출결현황
  - `context_external_tool_9`: 전자출석부
- `lti_apps/launch_definitions`도 200. `definition_id`, `name`, `description`, placement URL을 반환한다.

구현 제안:

- tool id 하드코딩을 유지하더라도, 실패 시 `tabs`/`launch_definitions`에서 label/name으로 재탐색한다.
- `강의자료실`, `주차학습`, `게시판` label은 한국어 UI 의존이 있으므로 `definition_id`와 `description`도 같이 매칭한다.

### 3. 과제 제출

Phase 5 문서에도 반영된 후보.

API-only 후보:

```text
POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions/self/files
POST <upload_url>
POST /api/v1/courses/:course_id/assignments/:assignment_id/submissions
```

검증 결과:

- `POST .../submissions/self/files`에 `name`, `size`, `content_type`을 보내면 200.
- 응답에 `upload_url`, `upload_params` 포함.
- `upload_url` origin: `https://kr.object.gov-ncloudstorage.com`
- `POST .../submissions`는 invalid submission type probe에서 400 JSON 응답. route와 학생 권한은 살아 있음.

구현 제안:

- Canvas API 3단계를 1순위로 구현한다.
- 최종 제출 실패 시 Playwright UI 폴백을 유지한다.
- 코멘트는 Canvas 공식 파라미터 `comment[text_comment]`를 사용한다.

### 4. 과제 목록 개선

현재:

- `eclass_get_assignments`는 `GET /api/v1/planner/items` 기반이라 반환값에 `assignment_id`가 직접 없다.

API 후보:

```text
GET /api/v1/courses/:course_id/assignments?include[]=submission&per_page=100
```

구현 제안:

- `course_id`가 주어진 경우 planner 대신 course assignments API를 사용하면 `assignment_id`, `submission_types`, `allowed_extensions`, `allowed_attempts`를 바로 반환할 수 있다.
- 전체 강의/마감 임박 조회는 planner가 편하므로 두 경로를 병행한다.

## 전환 우선순위 중간

### 5. ModuleBuilder / 주차학습

현재:

- `BrowserSession.interceptModulebuilder(courseId)`
- Playwright로 `/courses/:course_id/external_tools/211` 로드
- `/learningx/api/v1/courses/:course_id/modules?include_detail=true` 응답 인터셉트

API-only 후보:

```text
GET /api/v1/courses/:course_id/external_tools/sessionless_launch?id=211&launch_type=course_navigation
GET <sessionless_launch.url>
POST /learningx/lti/modulebuilder
GET /learningx/api/v1/courses/:course_id/modules?include_detail=true
GET /learningx/api/v1/courses/:course_id/lessons
GET /learningx/api/v1/courses/:course_id/settings?role=1
GET /learningx/api/v1/courses/:course_id/sis_course/check
```

검증 결과:

- `sessionless_launch?id=211` 200, LTI form 반환.
- LTI form action: `https://eclass3.cau.ac.kr/learningx/lti/modulebuilder`
- HTTP LTI POST 후 `xn_api_token` 발급 확인.
- `xn_api_token` Bearer로 `modules?include_detail=true` 200.
- 단, `course_id=<course_id>`에서는 modules 배열 length 0. 실제 주차학습 자료가 있는 다른 과목에서 추가 검증 필요.

구현 제안:

- 다른 과목에서 데이터가 있는지 먼저 확인한다.
- 응답 shape가 기존 `parseModulebuilderItems`와 맞으면 API-only로 대체한다.
- 데이터가 빈 배열인 과목도 정상 결과로 처리해야 한다.

### 6. LearningX 게시판

현재 MCP에는 게시판 전용 툴이 없다. 하지만 API 전환/확장 후보로 가치가 있다.

API-only 후보:

```text
GET /api/v1/courses/:course_id/external_tools/sessionless_launch?id=209&launch_type=course_navigation
GET <sessionless_launch.url>
POST /learningx/lti/learningx_board/boards
GET /learningx/api/v1/learningx_board/courses/:course_id/boards
```

검증 결과:

- `sessionless_launch?id=209` 200, LTI form 반환.
- LTI form action: `https://eclass3.cau.ac.kr/learningx/lti/learningx_board/boards`
- HTTP LTI POST 후 `xn_api_token` 발급 확인.
- `xn_api_token` Bearer로 boards API 200.
- `course_id=<course_id>` 기준 board 1개 반환.

구현 제안:

- 새 툴 후보: `eclass_get_boards`, `eclass_get_board_posts`.
- 게시글 목록/상세 endpoint는 board 화면을 한 단계 더 열어 dry-run 캡처 필요.

## 추가 확인 필요

### 7. OCS 파일 다운로드

현재:

- `ocs.cau.ac.kr/em/...` viewer를 Playwright로 열고 다운로드 가능한 response를 intercept한다.

기존 판단:

- CourseResource API는 `commons_content.view_url`, `content_id`, `file_name`은 주지만 direct download URL은 주지 않는다.
- OCS는 eclass/Canvas와 별도 서버 API를 붙인 구조로 보인다.

추가 디스커버리 결과 (`과학기술과현대사회 02분반`, `course_id=140335`, 10주차):

- ModuleBuilder API에서 10주차 동영상 `view_url` 확인:
  - `[SHANA]10. 과학이란 무엇인가 2026-1(동영상1)` → `https://ocs.cau.ac.kr/em/6a11c78f348bf`
  - `[SHANA]10. 과학이란 무엇인가 2026-1(동영상2)` → `https://ocs.cau.ac.kr/em/6a11c7f073495`
  - `[SHANA]10. 과학이란 무엇인가 2026-1(동영상3)` → `https://ocs.cau.ac.kr/em/6a11c7ff4fffa`
  - `10. 과학이란 무엇인가 2026-1(동영상2)` → `https://ocs.cau.ac.kr/em/6a1839b77c5a5`
  - `10. 과학이란 무엇인가 2026-1(동영상3)` → `https://ocs.cau.ac.kr/em/6a1839d7776f1`
- `GET /viewer/ssplayer/uniplayer_support/content.php?content_id=<id>`가 XML metadata를 반환한다.
- XML에 `<main_media>screen.mp4</main_media>`와 CDN template이 들어 있다.
- direct MP4 후보:

```text
https://cau-cms-object.cdn.gov-ntruss.com/contents_new/cau1000001/<content_id>/contents/media_files/screen.mp4
```

- `HEAD`/range probe 결과:
  - `6a11c78f348bf`: 200 `video/mp4`, 83,552,702 bytes, `Accept-Ranges: bytes`
  - `6a11c7f073495`: 200 `video/mp4`, 65,085,421 bytes, `Accept-Ranges: bytes`
  - `6a11c7ff4fffa`: 200 `video/mp4`, 81,178,077 bytes, `Accept-Ranges: bytes`
  - `6a1839b77c5a5`: 200 `video/mp4`, 297,070,687 bytes, `Accept-Ranges: bytes`
  - `6a1839d7776f1`: 200 `video/mp4`, 318,968,345 bytes, `Accept-Ranges: bytes`
- 첫 16 bytes range probe도 MP4 `ftypisom` signature로 확인됨.

구현 제안:

- OCS UniPlayer MP4는 API-only 다운로드 후보로 격상한다.
- 안전한 판별 순서:
  1. `view_url`에서 content id 추출.
  2. `content.php?content_id=<id>` XML fetch.
  3. `main_media` 파일명과 CDN media root 조합.
  4. `HEAD` 또는 `Range: bytes=0-15`로 `video/mp4`, `Accept-Ranges`, MP4 signature 확인.
  5. 확인된 direct MP4만 다운로드 허용.
- HLS(`m3u8`), segment stream, DRM/encrypted media, 진도/출석 추적용 이벤트 API 우회는 구현하지 않는다.
- 현재 `unsupported_streaming_media`를 일괄 실패 처리하고 있으므로, `ocs_uniplayer_mp4` 같은 별도 strategy로 분리하는 편이 안전하다.

## 다음 액션

1. `learningx-client.ts` 후보 작성:
   - Canvas `sessionless_launch` 호출
   - LTI form parse
   - HTTP POST
   - `xn_api_token` 추출
   - LearningX GET helper 제공
2. `fetchCourseresource`를 API-only 우선 + Playwright 폴백으로 변경.
3. external tool id 탐색을 `tabs`/`launch_definitions` 기반으로 보강.
4. Phase 5 제출은 Canvas API 3단계 우선 구현.
5. ModuleBuilder는 실제 데이터 있는 과목에서 한 번 더 검증 후 전환.
