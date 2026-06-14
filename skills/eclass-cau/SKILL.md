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
  `eclass_get_courses`), 이미 알고 있으면 다시 부르지 않는다.
- 단, **안전 게이트(아래)는 세션 컨텍스트와 무관하게 항상 수행한다.** "아까 확인했다"로
  생략하지 않는다.
- 캐시가 학기 경계로 오래됐거나 다운로드 후 `is_downloaded`가 바뀌었을 만하면 다시 확인한다.
- `[로컬]` 도구를 우선하고 `[네트워크]`는 꼭 필요할 때만 호출한다.

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
| "시험 언제/어디서" | 시험 시간표 |
| "교재 뭐 써 / 강의계획서" | 강의계획서 |
| "강의 백업/요약 내보내기" | 강의 백업 |
| 툴이 인증·브라우저 오류 | troubleshooting.md |

## 안전 게이트

- 과제 제출은 `dry_run: true`로 먼저 검증 → 결과를 사용자에게 보여주고 확인받은 뒤
  실제 제출. 이미 제출된 과제 재제출은 `confirm_resubmit: true` 명시.
- 다운로드 전 `is_downloaded`를 확인해 중복 다운로드를 피한다.
- 동영상은 `eclass_download_video`로 받는다. 파일 다운로드 툴이 영상을 거부하면
  (`next_action`) 그 안내를 따른다 — 직접 URL/타입을 판별하지 않는다.
