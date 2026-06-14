# ChatGPT Secure MCP Tunnel 셋업

eclass-mcp를 OpenAI Secure MCP Tunnel로 ChatGPT connector에 연결한다.
`tunnel-client` 설치는 자동화하지 않는다. 이 문서는 1회 셋업과 실행/중지를 다룬다.

## 0. 전제

- `tunnel-client` 설치 확인: `tunnel-client --version` (검증: v0.0.9).
  설치는 Platform Tunnels 화면의 바이너리 다운로드 안내를 따른다.
- eclass-mcp 빌드: `npm run build`.
- 암호화 자격증명 백엔드 설정 완료:
  `npm run setup -- --target encrypted` (자세히는 README "헤드리스 서버: 암호화 백엔드").

## 1. Tunnel 발급

1. Platform Tunnels에서 tunnel 생성 후 `tunnel_id`를 확보한다.
2. Tunnels Read + Use 권한 런타임 API 키를 발급한다.

## 2. 런타임 환경변수

권장: env 파일을 한 번 작성해두고 매번 `npm run chatgptui`만 실행한다.
`scripts/chatgptui.ts`가 시작 시 프로젝트 루트의 `.env.chatgptui`를 자동 로드한다.

```bash
cp .env.chatgptui.example .env.chatgptui
# .env.chatgptui 편집 후
npm run chatgptui
```

`.env.chatgptui`는 gitignore된다. 다른 경로를 쓰려면
`ECLASS_CHATGPTUI_ENV_FILE=/path/to.env npm run chatgptui`.
이미 셸에 `export`된 변수가 있으면 그 값이 파일보다 우선한다.

수동 export도 동일하게 동작한다:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123..."
export ECLASS_USERNAME="your_id"
export ECLASS_CREDENTIAL_BACKEND=encrypted
export ECLASS_SECRET_KEY="<base64 32바이트 마스터 키>"
```

`CONTROL_PLANE_API_KEY` 대신 `OPENAI_API_KEY`를 둘 수도 있다. 오케스트레이터가
child process 환경에서는 `CONTROL_PLANE_API_KEY`로도 주입한다.

## 3. 프로파일

`npm run chatgptui`가 프로파일을 자동 생성/검증한다. 기본 경로는
`${XDG_CONFIG_HOME:-~/.config}/tunnel-client/eclass-mcp.yaml`이며 Linux와 macOS에서 같다.
생성되는 프로파일은 로컬 MCP 인증으로 `X-Eclass-Auth` 헤더를 사용한다.

```yaml
config_version: 1
control_plane:
  tunnel_id: tunnel_0123...
  api_key: env:CONTROL_PLANE_API_KEY
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:8787/mcp
  extra_headers:
    X-Eclass-Auth: env:ECLASS_REMOTE_AUTH_TOKEN
  discovery_extra_headers:
    X-Eclass-Auth: env:ECLASS_REMOTE_AUTH_TOKEN
```

- 다른 경로를 쓰려면 `ECLASS_TUNNEL_PROFILE_FILE=/path/to.yaml`.
- 기본 관리 프로파일에 기존 `Authorization` static header가 있으면 `X-Eclass-Auth`로 자동 전환한다.
- `ECLASS_TUNNEL_PROFILE_FILE`로 지정한 사용자 프로파일은 자동 수정하지 않는다.
  `Authorization` static header가 있으면 중단하고 수동 전환을 안내한다.

## 4. 실행 / 중지

```bash
npm run chatgptui
npm run chatgptui:stop
```

`chatgptui`는 HTTP 서버를 먼저 띄우고, `tunnel-client doctor`로 preflight 후
`tunnel-client run`을 띄운다. `ECLASS_REMOTE_AUTH_TOKEN`은 선택값이다. 설정되어 있고
비어있지 않으면 그대로 사용한다. 미설정 또는 빈 문자열이면 오케스트레이터가 매 실행마다
랜덤 토큰을 생성해 HTTP 서버와 `tunnel-client`에만 주입한다.

두 프로세스를 오케스트레이터 밖에서 따로 재시작하거나 장기 고정 토큰이 필요하면
`ECLASS_REMOTE_AUTH_TOKEN`을 명시적으로 설정한다.

## 5. Readiness 확인

- tunnel-client 로그에 `mcp session initialized`가 보인다.
- `tunnel-client health` 또는 `/readyz`가 ready를 반환한다.
- ChatGPT Settings의 Connectors에서 tunnel을 선택한다.

## 6. 파일 핸드오프

`eclass_file_handoff`는 HTTP transport에서 base64를 컨텍스트에 싣지 않고 **파일 URL**(`http://127.0.0.1:8787/files/<token>`)만 텍스트로 반환한다. 이 응답은 파일 첨부가 아니므로 ChatGPT가 파일을 가진 것이 아니다. 파일을 보려면 반환된 URL을 브라우징 또는 브라우저에서 직접 열어야 한다. `/files/<token>` 응답은 `Content-Disposition: inline`으로 스트리밍되므로 PDF처럼 브라우저가 읽을 수 있는 파일은 바로 열 수 있고, 그 외 파일은 브라우저 정책에 따라 다운로드된다.

- 로컬 브라우저 다운로드만 필요하면 터널과 같은 머신에서 `127.0.0.1` 링크를 열면 된다(터널은 `/mcp`만 포워딩하므로 링크는 터널을 거치지 않고 localhost로 직접 받는다).
- ChatGPT 브라우징이 URL을 직접 열어 읽게 하려면 `/files/<token>`도 공개 인터넷에서 도달 가능해야 한다. 공개 HTTPS reverse proxy 또는 터널을 준비하고, `ECLASS_HANDOFF_BASE_URL`을 그 공개 주소로 지정한 뒤 `eclass_file_handoff`를 다시 호출해 공개 URL을 새로 발급한다.
- 토큰은 1회 발급되는 불투명 값이며 일정 시간 후 만료된다.

## 7. 트러블슈팅

- `oauth_metadata FAIL`: non-OAuth single-user 모드의 정상 케이스다. `chatgptui`는 이를 허용하고 진행한다.
- `tunnel-client doctor` 실행 불가: 자동 fallback하지 않고 중단한다. `tunnel-client` 설치와 `PATH`를 확인한다.
- `Password not found in credential store`: tunnel 문제가 아니라 자격증명 백엔드 문제다.
  `ECLASS_CREDENTIAL_BACKEND=encrypted`와 `ECLASS_SECRET_KEY` 또는 `ECLASS_SECRET_KEY_FILE` 주입을 확인한다.
- 401 from MCP: 프로파일의 `X-Eclass-Auth` 헤더와 두 child process의 `ECLASS_REMOTE_AUTH_TOKEN` 주입을 확인한다.
