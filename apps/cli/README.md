# camellia CLI

터미널에서 앱을 배포하고 상태를 보는 도구입니다. 명령 목록은 서버(`GET /api/v1/cli/manifest`)에서 받아서 만들기 때문에, 웹 콘솔에 API 와 명령이 추가되면 CLI 를 다시 설치하지 않아도 바로 쓸 수 있습니다. 명령 정의는 `apps/api/src/cli/manifest.ts` 에 있습니다.

Node.js 20 이상이면 되고, 따로 설치할 패키지는 없습니다.

## 설치

```sh
npm install -g ./apps/cli      # 저장소 루트에서
camellia --version
```

설치하지 않고 `node apps/cli/bin/camellia.mjs <명령>` 으로 써도 됩니다.

## 로그인

```sh
camellia login
```

콘솔 계정(아이디 · 비밀번호)으로 30일짜리 토큰을 받아 `~/.camellia/config.json` 에 저장합니다. 비밀번호는 저장하지 않습니다. 다른 서버를 쓰려면 `--url <주소>` 를 붙입니다.

## 자주 쓰는 명령

```sh
camellia apps list
camellia apps create shop --subdomain shop
camellia deploy shop ./my-app              # 폴더를 zip 으로 묶어 올리고 끝날 때까지 지켜봄
camellia deploy shop ./my-app --to onprem-mymac
camellia switch shop --to aws-ap-northeast-2-ABCD   # 서비스 중인 버전을 다른 연결로
camellia deployments shop
camellia logs 123 --step build --tail 50
camellia env set shop API_URL https://example.com
camellia help                              # 서버가 주는 전체 명령
```

공통 플래그: `--json` (응답 그대로), `--yes` (확인 생략), `--help`.

## 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 성공 |
| 1 | 요청 실패 · 입력 오류 |
| 2 | 로그인 필요 · 인증 만료 |
| 3 | 배포가 실패 · 취소로 끝남 |
