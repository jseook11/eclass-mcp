# eclass 흐름 레시피

각 의도를 정해진 순서로 처리한다. 파라미터 세부는 [TOOLS.md](TOOLS.md) 참조.
course 매치·자료 탐색 단계를 건너뛰지 않는다.

## 자료 다운로드

1. `eclass_get_courses_cached`로 강의 목록을 가져온다 (네트워크 없음).
2. 사용자가 말한 강의명을 목록과 매치해 `course_id`를 정한다. 모호하면 후보를
   보여주고 사용자가 고르게 한다 (추측 금지).
3. `eclass_get_materials { course_id }`로 자료 위치/목록을 탐색한다.
4. 결과에서 `is_downloaded: false`이고 동영상이 아닌 항목만 골라
   `eclass_download_materials_batch`에 한 번에 넘긴다 (각 항목의 `source`도 함께 전달).
   동영상 항목은 "동영상 다운로드" 흐름으로 보낸다.

## 동영상 다운로드

1~3. "자료 다운로드"의 1~3단계와 동일하게 `course_id`와 자료 목록 확보.
4. `type`이 mp4/video 계열이고 `url`이 `https://ocs.cau.ac.kr/em/...`인 항목을
   `eclass_download_video`로 다운로드한다.

## 마감 임박 과제

1. `eclass_get_assignments { days_ahead: 7, include_submitted: false }`로
   미제출 마감 임박 항목을 조회한다. (특정 강의면 `course_id`도 전달.)

## 과제 제출

1. `eclass_get_courses_cached`로 강의를 매치한다.
2. `eclass_get_assignments { course_id }`로 대상 과제와 `assignment_id`를 찾는다.
3. `eclass_get_assignment_detail`로 `submission_types`/`allowed_extensions`/마감을
   확인한다. `external_tool`(LTI)이면 이 툴로 제출 불가임을 알린다.
4. `eclass_submit_assignment`를 `dry_run: true`로 먼저 호출해 검증 결과를 본다.
5. 검증 결과를 사용자에게 보여주고 확인받은 뒤 `dry_run: false`로 실제 제출한다.
   이미 제출된 과제 재제출이면 `confirm_resubmit: true`를 함께 전달한다.

## 성적 조회

1. (특정 강의면) `eclass_get_courses_cached`로 매치.
2. `eclass_get_grades`(전체) 또는 `eclass_get_grades { course_id }`(강의별 + 과제 점수).

## 시험 시간표

1. `eclass_get_courses_cached`로 강의를 매치한다.
2. 필요 시 `eclass_sync_course_metadata { course_id }`로 메타데이터를 동기화한다
   (조회 툴이 자동 1회 동기화하기도 함).
3. `eclass_get_exam_schedule { course_id }`로 조회한다. 실패 시 `candidates`를 보고
   사용자와 함께 판단한다.

## 강의계획서

1. `eclass_search_syllabus { query }`로 후보 목록을 가져온다.
2. 후보에서 대상 행을 사용자와 함께 고른다 (자동 매칭 안 함).
3. 고른 행의 `year/term/course_code/section`을 그대로
   `eclass_get_syllabus`에 넘겨 상세를 조회한다.

## 강의 백업

1. `eclass_get_courses_cached`로 강의를 매치한다.
2. `eclass_export_course_snapshot { course_id, format, output_path }`로 내보낸다.
