---
name: eclass-cau
description: 중앙대 eclass(LearningX/Canvas) 작업 — 강의·과제·성적 조회, 자료/동영상 다운로드, 과제 제출(dry-run), 기말시험 시간표, 강의계획서 검색. "이번 주 과제", "성적 알려줘", "강의자료 받아줘", "시험 언제", "교재 뭐 써", "과제 제출해줘" 같은 eclass 관련 요청에 사용. eclass_* MCP 툴이 연결돼 있을 때만 동작.
---

# eclass-cau

중앙대 eclass(eclass-mcp 서버)를 다룰 때, `eclass_*` 툴을 **정해진 순서대로** 조합한다.
파라미터 세부 명세는 [references/TOOLS.md](references/TOOLS.md), 멀티스텝 레시피는
[references/flows.md](references/flows.md), 오류 대응은 [references/troubleshooting.md](references/troubleshooting.md).

## 시작 규칙

- 거의 모든 흐름은 `eclass_get_courses_cached`로 course_id 확보부터 시작한다.
  캐시가 비었거나 강의가 안 보일 때만 `eclass_get_courses`(네트워크).
- `[로컬]` 도구를 우선하고 `[네트워크]`는 꼭 필요할 때만 호출한다.

## 순서를 건너뛰지 말 것

각 흐름의 번호 순서를 지킨다. **특히 course 매치와 자료 탐색(`eclass_get_materials`)을
생략하고 다운로드/제출 툴을 곧바로 호출하지 않는다.** course_id를 모를 때 추측하지
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
- 동영상(`type`이 mp4/video 계열, `ocs.cau.ac.kr/em/...`)은 `eclass_download_video`로
  처리한다. 파일 다운로드 툴에 동영상을 넘기지 않는다.
