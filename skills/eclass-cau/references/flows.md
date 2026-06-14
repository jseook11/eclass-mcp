# eclass 흐름 레시피

각 의도를 정해진 순서로 처리한다. 단계 끝의 `(C#)`는 [io-contracts.md](io-contracts.md)의
규약 ID다 — 그 단계는 해당 규약(필수값 출처·필드명 변환·안전 조건)을 따른다. 파라미터
세부는 [TOOLS.md](TOOLS.md) 참조. course 매치·자료 탐색 단계를 건너뛰지 않는다.

## 자료 다운로드

1. `eclass_get_courses_cached`로 강의 목록을 가져온다 (네트워크 없음). (C1)
2. 강의명을 목록과 매치해 `course_id`를 정한다. 모호하면 후보를 제시한다. (C1)
3. `eclass_get_materials { course_id }`로 자료 위치/목록을 탐색한다.
4. `is_downloaded: false`인 항목을 `eclass_download_materials_batch`에 넘긴다. 영상
   항목은 배치가 거부·안내하므로 "동영상 다운로드" 흐름으로 받는다. (C2, C4)

## 동영상 다운로드

1~3. "자료 다운로드"의 1~3단계와 동일하게 `course_id`와 자료 목록 확보. (C1)
4. 대상 자료를 `eclass_download_video`로 다운로드한다. (C2, C3)

## 마감 임박 과제

1. `eclass_get_assignments { days_ahead: 7, include_submitted: false }`로 미제출
   마감 임박 항목을 조회한다. (특정 강의면 `course_id`도 전달.) (C9)

## 과제 제출

1. `eclass_get_courses_cached`로 강의를 매치한다. (C1)
2. `eclass_get_assignments { course_id }`로 대상 과제와 `assignment_id`를 찾는다. (C5)
3. `eclass_get_assignment_detail`로 `submission_types`/`allowed_extensions`/마감을
   확인한다. `external_tool`(LTI)이면 제출 불가임을 알린다. (C5, C6)
4. `eclass_submit_assignment`를 `dry_run: true`로 먼저 호출해 검증 결과를 본다. (C6)
5. 검증 결과를 사용자에게 보여주고 확인받은 뒤 `dry_run: false`로 실제 제출한다.
   재제출이면 `confirm_resubmit: true`를 함께 전달한다. (C6)

## 성적 조회

1. (특정 강의면) `eclass_get_courses_cached`로 매치. (C1)
2. `eclass_get_grades`(전체) 또는 `eclass_get_grades { course_id }`(강의별 + 과제 점수). (C9)

## 시험 시간표 (특정 강의)

1. `eclass_get_courses_cached`로 강의를 매치한다. (C1)
2. 필요 시 `eclass_sync_course_metadata { course_id }`로 메타데이터를 동기화한다. (C8)
3. `eclass_get_exam_schedule { course_id }`로 조회한다. 실패 시 `candidates`를 보고
   사용자와 함께 판단한다. (C8)

## 시험 일정 전체 ("X요일에 시험 있어?", "내 시험 언제")

특정 강의가 아니라 내 전체 일정을 묻는 경우. 한 강의도 빠뜨리면 안 된다. (C10)

1. `eclass_get_courses_cached`로 수강 강의 전체 목록을 확보한다. (C1)
2. **모든** course_id에 대해 시험 일정을 확인한다 — 강의별 반복보다
   `eclass_get_exam_schedule { term }`로 전체 schedule을 받아 내 강의와 대조하는 쪽이
   누락이 적다. 강의별로 돌 경우 처리한 course_id 집합이 1번 목록과 일치하는지 점검한다. (C8, C10)
3. 조회하지 않았거나 결과를 못 받은 강의는 "시험 없음"이라 단정하지 말고 그대로 밝힌다. (C10)

## 강의계획서

1. `eclass_search_syllabus { query }`로 후보 목록을 가져온다.
2. 후보에서 대상 행을 사용자와 함께 고른다 (자동 매칭 안 함).
3. 고른 행을 `eclass_get_syllabus` 입력으로 매핑해 상세를 조회한다. (C7)

## 강의 백업

1. `eclass_get_courses_cached`로 강의를 매치한다. (C1)
2. `eclass_export_course_snapshot { course_id, format, output_path }`로 내보낸다. (C9)
