# 입력 규약 & 값 출처 (provenance)

각 툴의 **필수 입력**과 그 값이 **어느 앞 단계 출력에서 오는지**만 정리한다.
필수값을 추측하지 말고 반드시 출처 툴의 출력 필드에서 가져온다. 출력 필드의
전체 의미·옵션 입력은 [TOOLS.md](TOOLS.md) 참조. (필수=●, 출처가 있으면 ←표시)

## course_id (거의 모든 흐름의 출발점)

- 출처: `eclass_get_courses_cached`(우선) 또는 `eclass_get_courses`의 출력 `id`.
- 강의명만 알 때 `course_id`를 지어내지 않는다. 목록의 `name`을 사용자가 말한
  강의와 매치해 그 행의 `id`를 쓴다. 모호하면 후보를 제시한다.

## 자료 → 다운로드 (필드명이 바뀐다, 주의)

`eclass_get_materials` 출력의 각 `material`을 다운로드 툴 입력으로 옮길 때 이름이 바뀐다:

| 다운로드 입력 | ← material 출력 필드 | 필수 |
|---|---|---|
| `file_id` (batch/file) 또는 `video_id` (video) | `material.id` | ● |
| `display_name` | `material.title` | ● |
| `url` | `material.url` | file/batch: 선택(null 가능) · **video: 필수, null 불가** |
| `type` | `material.type` | 선택 |
| `source` | `material.source` | 선택(넘기면 검색 캐시에 기록) |
| `course_id` | 흐름의 course_id | ● |

- `eclass_download_materials_batch`: `materials: [{ file_id, display_name, ... }]` 배열.
  `file_id`·`display_name` 필수. 영상 항목은 배치가 거부하고 `eclass_download_video`를
  안내하므로 그 항목만 영상 툴로 보낸다 (영상 판별은 서버가 한다).
- `eclass_download_video`: `video_id`·`url`·`display_name` 필수. `url`은 null일 수 없다.

## 과제 → 상세/제출

- `eclass_get_assignment_detail`·`eclass_submit_assignment` 필수: `course_id` ● + `assignment_id` ●.
- `assignment_id` 출처: `eclass_get_assignments`(`course_id` 지정 호출)의 출력
  `assignment_id`. 없으면 항목 `url` 끝의 숫자에서 얻는다.
- `eclass_submit_assignment` 추가 규약:
  - `file_paths`(online_upload)와 `body`(online_text_entry)는 **동시 지정 불가**(택1).
  - `dry_run` 기본 `true` — 실제 제출은 명시적으로 `false`로 줄 때만.
  - 이미 제출된 과제 재제출은 `confirm_resubmit: true` 필요.
  - 제출 유형은 먼저 `eclass_get_assignment_detail`의 `submission_types`로 확인
    (`external_tool`이면 이 툴로 제출 불가).

## 강의계획서: 검색 → 상세 (필드명이 바뀐다, 주의)

`eclass_get_syllabus`의 필수 입력은 `eclass_search_syllabus` 출력 행에서 이름이 바뀐다:

| get_syllabus 입력 | ← search_syllabus 출력 필드 | 필수 |
|---|---|---|
| `year` | `year` | ● |
| `term` | `term` | ● |
| `sbjtno1` (학수번호) | `course_code` | ● |
| `clssno1` (분반) | `section` | ● |
| `campcd` | `campus_code` | 선택 |
| `sust` | `sust_code` | 선택 |

- 검색 행을 그대로 매핑해 넘기는 것이 가장 안전하다. 학수번호=`course_code`,
  분반=`section`임을 혼동하지 않는다.

## 시험 시간표

- `eclass_get_exam_schedule`: `course_id`로 조회하려면 먼저 그 강의의 메타데이터가
  있어야 한다 → 필요 시 `eclass_sync_course_metadata { course_id }` 선행
  (조회 툴이 자동 1회 동기화하기도 함). `course_id` 없이 `query`(이름/과목코드/교수명
  LIKE)로도 조회 가능.
- `eclass_sync_exam_schedules` 필수: `term` ● (예: `"2026-1"`). `refresh=true`로
  조회를 강제할 때도 `term`이 필요하다.

## 강의 백업

- `eclass_export_course_snapshot` 필수: `course_id` ●. `output_path` 지정 시 기존
  파일이 있으면 `overwrite: true` 없이는 거부된다.

## 입력이 없는(또는 course_id만 선택) 조회 툴

- `eclass_get_courses` / `eclass_get_courses_cached` / `eclass_doctor` /
  `eclass_get_grades` / `eclass_list_downloads` / `eclass_get_download_status` /
  `eclass_search_downloads` / `eclass_list_exam_sources` — 필수 입력 없음
  (대부분 `course_id`는 선택, 생략 시 전체).
- `eclass_get_announcements` 필수: `course_id` ●.
