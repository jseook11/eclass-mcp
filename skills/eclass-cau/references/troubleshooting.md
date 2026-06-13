# 오류 대응

- 툴이 인증/브라우저/API 오류를 내면 먼저 `eclass_doctor`를 호출해 실패한 check의
  `detail`로 원인을 본다. 인증 문제면 `npm run setup` 재실행을 안내한다.
  엔드포인트/디스커버리 배경은 `docs/DISCOVERY.md` 참조.
- 시험 시간표 파서나 공지 소스가 깨진 것으로 의심되면 `eclass_list_exam_sources`로
  `last_status`/`last_error`를 확인하고 `docs/SELF_REPAIR.md` 절차를 따른다.
