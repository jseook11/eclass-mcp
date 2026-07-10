# 보안 가이드

eclass-mcp는 한 사용자의 LMS 계정·자격증명·학습 자료를 다루는 개인용
서버다. 기본 stdio transport가 가장 작은 공격 표면을 가지며, HTTP나 tunnel은
필요할 때만 명시적으로 켠다.

## 지원 범위와 보고

최신 `main` 및 최신 배포 버전에 대해 보안 수정을 제공한다. 취약점을 발견하면
공개 issue에 자격증명·토큰·학생 정보나 악용 가능한 상세를 올리지 않는다. 별도
비공개 연락 경로가 없으면 공개 issue에는 민감정보를 제거한 영향 범위와 비공개
연락 요청만 남긴다. 상세 재현에서는 실제 비밀값을 모두 대체한다.

## HTTP 배포 경계

- 인증 없는 HTTP 모드는 신뢰할 수 있는 단일 사용자 머신의 **loopback
  테스트 전용**이다. `127.0.0.1`은 공개 인터넷을 차단하지만 같은 호스트의 다른
  프로세스나 OS 사용자를 인증하지는 않는다.
- reverse proxy, ngrok, SSH/port forwarding, 외부 tunnel로 `/mcp`를 노출할 때는
  긴 랜덤 `ECLASS_REMOTE_AUTH_TOKEN`과 HTTPS 또는 동등한 접근 제어가 필수다.
  proxy가 `Authorization` 또는 `X-Eclass-Auth` 헤더를 보존하는지 검증한다.
- `Origin`/CORS allowlist는 브라우저 보호이지 인증·TLS·tunnel 접근 제어를
  대체하지 않는다.
- `pnpm run chatgptui`는 `ECLASS_REMOTE_AUTH_TOKEN`이 없을 때마다 랜덤 HTTP 인증
  토큰을 생성해 HTTP 서버와 tunnel-client에 주입한다. 명시적으로 설정한 토큰은
  재사용한다. 두 프로세스를 별도로 실행하면 운영자가 동일한 긴 랜덤 토큰을 양쪽에
  명시적으로 주입해야 한다.
- `/files/<token>` 링크의 불투명 토큰 자체가 자격증명이다. 공개 handoff base URL을
  설정했다면 링크를 로그·공개 채팅·issue에 남기지 않는다.

## 비밀 및 키 관리

### 암호화 자격증명 마스터 키

헤드리스 환경에서는 마스터 키를 터미널에 출력하지 않고 repo 밖의 파일에
생성한다.

```bash
pnpm run setup -- --target encrypted \
  --generate-master-key-file "$HOME/.config/eclass-mcp/master.key"
```

키 파일은 소유자만 읽을 수 있는 `0600`, 부모 디렉터리는 `0700`을 유지하고
repo·동기화 폴더·백업 범위 밖에 둔다. 실행 시 `ECLASS_SECRET_KEY_FILE`로 경로를
명시하거나, 비밀 관리 도구가 base64 키를 `ECLASS_SECRET_KEY`로 직접 주입한다.
Windows에서는 POSIX mode 검사를 적용할 수 없으므로 파일 ACL을 현재 서비스 계정으로
제한한다.

Hermes 호환용 `ALLOW_PLAINTEXT_ENV_SECRETS=1`은 LMS 비밀번호의 입력 경로만
바꾼다. Canvas token/session 캐시는 계속 keytar 또는 encrypted backend에 기록되므로
평문 override를 secure credential backend의 대체 수단으로 사용하지 않는다.

### Canvas 액세스 토큰

eclass-mcp는 새 Canvas 토큰에 90일 서버 만료를 요청하고 교체 후 이전 토큰 폐기를
시도한다. 실패한 폐기 대상은 secure revocation ledger에 보존해 다음 인증 실행에서
재시도한다. 네트워크 오류나 비정상 종료를 고려해 Canvas 프로필 설정의 `eclass-mcp`
액세스 토큰을 주기적으로 검토하고, 더 이상 사용하지 않는 이전 토큰은 Canvas에서
폐기한다. 로컬 캐시의 만료 메타데이터는
Canvas 서버의 토큰 만료·폐기를 보장하지 않는다. 토큰 유출이 의심되면 로컬
캐시만 지우지 말고 Canvas 프로필에서 해당 토큰을 즉시 revoke한 뒤 재인증한다.

### Tunnel control-plane 키

`CONTROL_PLANE_API_KEY`는 해당 tunnel에 필요한 **Tunnels Read+Use** 권한만 가진
전용 런타임 키를 사용한다. 관리자 키나 일반 용도의 `OPENAI_API_KEY`를 재사용하지
않고, 개발·운영 환경별로 키를 분리한다.

## 사고 대응

비밀 유출, 예상하지 않은 LMS 조작, tunnel 오용이 의심되면 다음 순서로 대응한다.

1. eclass-mcp HTTP 서버와 tunnel-client를 즉시 중지하고 reverse proxy/forwarding을 닫는다.
2. Canvas 프로필에서 모든 의심 토큰을 revoke한다. 세션·비밀번호 탈취가 의심되면
   CAU 비밀번호를 변경하고 활성 세션도 종료한다.
3. `ECLASS_REMOTE_AUTH_TOKEN`과 `CONTROL_PLANE_API_KEY`를 재발급하고 기존 키를 폐기한다.
4. 마스터 키 유출이 의심되면 기존 `secrets.enc`를 증거/복구용으로 별도 격리하고
   원래 경로에서 치우거나, 새 빈 `ECLASS_ENC_STORE_PATH`를 지정한다. 그 다음 새 키로
   encrypted setup을 실행해 LMS 비밀번호를 다시 입력한다. 새 키는 기존 암호문을
   복호화하지 못하므로 기존 파일 위에서 그대로 재실행하면 실패한다. 기존 저장소의
   Canvas token/session도 신뢰하지 말고 2단계의 서버 측 revoke를 반드시 수행한다.
5. 공개된 handoff URL, proxy/tunnel 로그, 프로세스 환경, shell history를 점검하고
   학습 자료·학생 정보가 포함된 로그나 링크를 폐기한다.
6. 영향 범위와 시간대를 기록하고, 코드 취약점이면 위 비공개 보고 경로를 사용한다.

## 의존성과 변경 검증

- Node.js 24.x와 pnpm 11.6.0을 사용하고 추적된 `pnpm-lock.yaml`로
  `pnpm install --frozen-lockfile`을 실행한다.
- CI는 변경 불가능한 commit SHA로 GitHub Actions을 고정하고 소스 읽기 권한만 준다.
- 배포 전 `pnpm run build`, `pnpm test`, `pnpm audit --prod --audit-level=high`를 통과한다.
