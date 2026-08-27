---
name: eclass-cau
description: 중앙대 eclass(LearningX/Canvas) 작업 — 강의·과제·성적 조회, 자료/동영상 다운로드, 과제 제출(dry-run), 기말시험 시간표, 강의계획서 검색. "이번 주 과제", "성적 알려줘", "강의자료 받아줘", "시험 언제", "교재 뭐 써", "과제 제출해줘" 같은 eclass 관련 요청에 사용. eclass_* MCP 툴이 연결돼 있을 때만 동작.
---

# eclass-cau

중앙대 eclass(eclass-mcp 서버)를 다룰 때, `eclass_*` 툴을 **정해진 순서대로** 조합한다.
멀티스텝 레시피는 [references/flows.md](references/flows.md), 필수 입력과 그 값의 출처
(필드명 변환 포함)는 [references/io-contracts.md](references/io-contracts.md), 파라미터
세부 명세는 [references/TOOLS.md](references/TOOLS.md), 오류 대응은
[references/troubleshooting.md](references/troubleshooting.md).

## 시작 규칙

- 선행 단계는 "툴을 반드시 호출"이 아니라 **"그 값을 확보한 상태"** 를 뜻한다.
  이번 세션에서 이미 신뢰할 수 있게 얻은 값(course_id 등)은 재호출 없이 재사용한다.
  course_id가 필요하면 `eclass_get_courses_cached`로 확보하되(비었으면
  `eclass_get_courses`), 이미 알고 있으면 다시 부르지 않는다. 기본 목록은 현재 학기
  일반 교과목이며, 이전 학기 전체는 `scope: "all"`, 예방/의무교육은
  `scope: "training"`을 명시한다.
- 단, **안전 게이트(아래)는 세션 컨텍스트와 무관하게 항상 수행한다.** "아까 확인했다"로
  생략하지 않는다.
- 캐시가 학기 경계로 오래됐거나 다운로드 후 `is_downloaded`가 바뀌었을 만하면 다시 확인한다.
- `[로컬]` 도구를 우선하고 `[네트워크]`는 꼭 필요할 때만 호출한다.

## 자료 탐색 원칙

- 강의자료는 한 저장소에만 있다고 가정하지 않는다. 주차학습(ModuleBuilder),
  LearningX 강의자료실(CourseResource), 공지 첨부파일, Canvas 모듈에 연결된 링크와
  외부도구에 분산될 수 있으므로 결과를 모두 수집해 합친다. 한 경로에서 자료를
  찾았다고 다른 경로를 생략하지 않는다.
- 자료 위치의 논리적 우선도는 `modulebuilder`(주차학습) → `courseresource`(강의자료실)
  → `announcements`(공지 첨부) → `modules`/`external`(보조 링크) → `files`(Canvas
  기본 파일함) 순으로 본다.
- 위 순서는 자료의 의미와 fallback 판단 순서이며, 여러 경로를 조회할 때 결과가
  한 곳에만 존재한다고 단정하지 않는다. 각 항목의 `source`를 보존한다.
- `files`는 중앙대 e-Class에서 교수 미사용 또는 학생 권한 제한으로 401이 날 수 있는
  Canvas 기본 파일함이다. 기본 자료 탐색에서는 먼저 `modulebuilder`,
  `courseresource`, `announcements`, `modules`, `external`을 조회하고, Files 탭이
  실제로 노출되거나 사용자가 명시적으로 요청한 경우에만 `files`를 마지막으로
  확인한다.
- `files`의 401 응답은 토큰 만료로 단정하지 않는다. 권한 거부로 기록하고 인증
  갱신을 반복하지 않는다. 다른 자료 source가 성공하면 전체 자료 조회는 부분
  성공으로 처리한다.

## 출력 규칙

핵심만 간결하게. 진행 중계("이제 ~하겠습니다")·완료 인사·툴 호출 나열·미사여구는
생략한다. 단 다음은 항상 사용자에게 보여준다: ① 모호할 때의 후보(C1),
② dry_run 등 확인이 필요한 안전 결과(C6), ③ 최종 답.
조회 범위를 일부만 본 채 단정하지 않는다 — 생략·미확인이 있으면 그 사실을 밝힌다(C10).

## 순서를 건너뛰지 말 것

각 흐름의 번호 순서를 지키되, 이미 확보한 값의 재확보 호출은 건너뛸 수 있다(위 시작 규칙).
**값 없이 다운로드/제출 툴을 곧바로 호출하거나 course_id를 추측하지 않는다.** course_id를 모를 때 추측하지
말고 목록을 보여주고 사용자가 고르게 한다.

## 라우팅

| 사용자 요청 | 흐름 (flows.md) |
|---|---|
| "○○ 자료 받아줘" | 자료 다운로드 |
| "동영상 받아줘" | 동영상 다운로드 |
| "이번 주/마감 과제" | 마감 임박 과제 |
| "과제 제출해줘" | 과제 제출 |
| "성적 알려줘" | 성적 조회 |
| "특정 강의 시험 언제/어디서" | 시험 시간표 (특정 강의) |
| "X요일에 시험 있어 / 내 시험 일정" | 시험 일정 전체 (전수 조회, C10) |
| "교재 뭐 써 / 강의계획서" | 강의계획서 |
| "강의 백업/요약 내보내기" | 강의 백업 |
| 툴이 인증·브라우저 오류 | troubleshooting.md |

## 안전 게이트

- 과제 제출은 `dry_run: true`로 먼저 검증 → 결과를 사용자에게 보여주고 확인받은 뒤
  실제 제출. 이미 제출된 과제 재제출은 `confirm_resubmit: true` 명시.
- 다운로드 전 `is_downloaded`를 확인해 중복 다운로드를 피한다.
- 동영상은 `eclass_download_video`로 받는다. 파일 다운로드 툴이 영상을 거부하면
  (`next_action`) 그 안내를 따른다 — 직접 URL/타입을 판별하지 않는다.
