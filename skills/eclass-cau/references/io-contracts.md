# 입력 규약 (Contracts)

각 규약은 IO 스키마만으로는 안 나오는 **필수값의 출처·필드명 변환·안전 조건**이다.
[flows.md](flows.md)의 각 단계가 `(C1)`처럼 ID로 이 규약을 가리킨다. 출력 필드의
전체 의미·옵션 입력은 [TOOLS.md](TOOLS.md) 참조. (필수 = ●)

출처(provenance) 규약은 "값을 확보한 상태"를 요구할 뿐, 매번 재호출을 요구하지 않는다.
이번 세션에서 이미 신뢰할 값을 얻었으면 재사용한다. **단 안전 규약(C6)은 컨텍스트와
무관하게 항상 수행한다.**

## C1 — course_id의 출처

`course_id`는 `eclass_get_courses_cached`(우선) 또는 `eclass_get_courses` 출력의
`id`에서만 가져온다. 강의명만 알 때 지어내지 않는다. 목록 `name`을 사용자가 말한
강의와 매치해 그 행의 `id`를 쓰고, 모호하면 후보를 제시해 고르게 한다. 이번 세션에서
이미 매치해 둔 `course_id`는 다시 조회하지 않고 재사용한다(학기가 바뀌었을 만하면 갱신).

## C2 — 자료 → 다운로드 필드명 변환

`eclass_get_materials` 출력의 `material`을 다운로드 입력으로 옮길 때 이름이 바뀐다:

| 다운로드 입력 | ← material 필드 | 필수 |
|---|---|---|
| `file_id`(file/batch) / `video_id`(video) | `material.id` | ● |
| `display_name` | `material.title` | ● |
| `url` | `material.url` | C3 참조 |
| `type` | `material.type` | 선택 |
| `source` | `material.source` | 선택(넘기면 검색 캐시에 기록) |
| `course_id` | 흐름의 course_id (C1) | ● |

## C3 — url 필수 여부 (파일 vs 영상)

- `eclass_download_file` / `eclass_download_materials_batch`: `url`은 선택이며 null
  가능(courseresource는 Playwright 경로).
- `eclass_download_video`: `url` **필수, null 불가**. `video_id`·`display_name`도 필수.

## C4 — 영상 라우팅은 서버에 맡긴다

영상인지 직접 URL/타입으로 판별하지 않는다. `eclass_download_materials_batch`가
영상 항목을 거부하며 `next_action`으로 `eclass_download_video`를 안내하므로, 그
항목만 영상 툴로 보낸다.

## C5 — assignment_id의 출처

`eclass_get_assignment_detail`·`eclass_submit_assignment`는 `course_id` ● +
`assignment_id` ●. `assignment_id`는 `eclass_get_assignments`(`course_id` 지정 호출)
출력의 `assignment_id`에서 얻는다. 없으면 항목 `url` 끝의 숫자에서 얻는다.

## C6 — 과제 제출 안전 조건 (컨텍스트와 무관하게 항상)

- `file_paths`(online_upload)와 `body`(online_text_entry)는 **동시 지정 불가**(택1).
- `dry_run` 기본 `true`. 실제 제출은 `dry_run: false`를 명시할 때만.
- 이미 제출된 과제 재제출은 `confirm_resubmit: true` 필요.
- 제출 전 `eclass_get_assignment_detail`의 `submission_types`로 유형 확인
  (`external_tool`이면 이 툴로 제출 불가).

## C7 — 강의계획서: 검색 → 상세 필드명 변환

`eclass_get_syllabus`의 입력은 `eclass_search_syllabus` 출력 행에서 이름이 바뀐다.
검색 행을 그대로 매핑하는 것이 가장 안전하다:

| get_syllabus 입력 | ← search_syllabus 필드 | 필수 |
|---|---|---|
| `year` | `year` | ● |
| `term` | `term` | ● |
| `sbjtno1` (학수번호) | `course_code` | ● |
| `clssno1` (분반) | `section` | ● |
| `campcd` | `campus_code` | 선택 |
| `sust` | `sust_code` | 선택 |

## C8 — 시험 시간표 선행 조건

- `eclass_get_exam_schedule`를 `course_id`로 조회하려면 그 강의 메타데이터가 있어야
  한다 → 필요 시 `eclass_sync_course_metadata { course_id }` 선행(조회 툴이 자동 1회
  동기화하기도 함). `course_id` 없이 `query`(이름/과목코드/교수명 LIKE)로도 조회 가능.
- `eclass_sync_exam_schedules`는 `term` ● (예: `"2026-1"`). `refresh=true` 조회 강제
  시에도 `term`이 필요하다.

## C9 — 단발 조회 툴

필수 입력 없음(대부분 `course_id`는 선택, 생략 시 전체):
`eclass_get_courses` / `eclass_get_courses_cached` / `eclass_doctor` /
`eclass_get_grades` / `eclass_list_downloads` / `eclass_get_download_status` /
`eclass_search_downloads` / `eclass_list_exam_sources`.
예외 — `eclass_get_announcements`·`eclass_export_course_snapshot`는 `course_id` ●.
