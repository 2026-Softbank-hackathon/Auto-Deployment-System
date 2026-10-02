# sample-monolith — 데모용 단일 서비스 샘플 앱

camellia 데모(배포 갱신 v1 → v2 · 온프레미스 ↔ 클라우드 전환)에 올리는 앱입니다. 평가 대상은 배포 시스템이라 앱은 가볍게, 대신 **실제 빌드 단계(`tsc` 타입 검사 + `esbuild` 번들)** 가 있게 만들었습니다.

- Node 24 + TypeScript + [Hono](https://hono.dev) (런타임 의존성 2개: `hono`, `@hono/node-server`)
- 실제 사용자 앱처럼 **독립 프로젝트**입니다. 자체 `package.json` · `package-lock.json`(npm)이 있고 모노레포 pnpm 워크스페이스에 속하지 않습니다. 이 폴더만 zip으로 올려도 `docker build`가 됩니다.

## 화면 · API

| 경로 | 응답 |
|---|---|
| `GET /` | 멀리서도 보이는 상태 화면 — 버전 배지(v1 파랑 · v2 초록), 실행 환경, 호스트(컨테이너 ID), 시작 시각, `APP_MESSAGE` |
| `GET /health` | `200 {"status":"ok","version":"v1"}` — 배포 시스템 기본 헬스체크 경로 |
| `GET /api/info` | 화면과 같은 값을 JSON으로 (스크립트 확인용) |

화면은 3초마다 `/api/info`를 확인해서 새 버전이 응답하기 시작하면 스스로 새로고침합니다(롤링 업데이트 중 v1 → v2 전환이 그대로 보임). 서버가 응답하지 않으면 오른쪽 위 표시가 `OFFLINE`으로 바뀝니다.

### 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 리슨 포트 |
| `APP_MESSAGE` | (없음) | 화면에 그대로 표시. 환경변수 주입이 되는지 확인용 |
| `DEPLOY_TARGET` | (자동) | 화면의 RUNNING ON 값. 비우면 `AWS ECS`(ECS 메타데이터 변수 존재) → `Docker`(`/.dockerenv` 존재) → `Local` 순으로 추정 |

`SIGTERM`(docker stop · ECS 태스크 종료)을 받으면 새 연결을 막고 처리 중인 요청만 마친 뒤 바로 종료합니다(최대 5초).

## 로컬 실행

```bash
npm ci
npm run build          # tsc 타입 검사 → esbuild 번들(dist/server.js 한 파일)
npm start              # http://localhost:3000
```

## Docker

ECS · 온프레미스(Intel Mac VM) 대상이라 `linux/amd64`로 빌드합니다.

Fargate 시작 시간(이미지 pull)을 줄이려고 런타임 이미지를 작게 만들었습니다. 빌드 스테이지(`node:24-alpine`)에서 의존성까지 `dist/server.js` 한 파일로 번들하고, 런타임은 `alpine:3.24`에 alpine 패키지 `nodejs`(Node 24)만 설치합니다. npm · yarn · `node_modules`는 들어가지 않고 `node` 사용자(uid 1000)로 실행합니다. 이미지 크기는 압축 기준 약 31MB입니다(공식 `node:24-alpine` 런타임일 때 약 62MB).

```bash
docker build --platform linux/amd64 -t camellia-sample-monolith:v1 .
docker run -d --name sample-monolith -p 3000:3000 -e APP_MESSAGE=hello camellia-sample-monolith:v1
curl localhost:3000/health     # {"status":"ok","version":"v1"}
docker stop sample-monolith && docker rm sample-monolith
```

## Docker Compose (SMP-04)

```bash
docker compose up -d --build --wait   # healthcheck 통과(healthy)까지 대기
curl localhost:3000/health
docker compose down --rmi local
```

## 데모: v1 → v2 올리기

버전은 **`src/version.ts` 한 곳**에만 있습니다. 커밋된 기본값은 `v1`입니다.

1. `src/version.ts`의 `APP_VERSION = "v1"`을 `"v2"`로 변경
2. 업로드용 zip 만들기 (아래)
3. 대시보드에서 같은 프로젝트에 zip 업로드 → 배포
4. 데모가 끝나면 `git checkout -- apps/samples/monolith/src/version.ts`로 되돌리기

## 업로드용 zip 만들기

저장소 루트에서 실행합니다. Windows Git Bash · macOS 공통입니다(별도 `zip` 설치 불필요).

```bash
REV=$(git stash create); git archive --format=zip -o "$HOME/sample-monolith.zip" "${REV:-HEAD}:apps/samples/monolith"
```

- git에 올라간 파일만 들어가므로 `node_modules` · `dist` · `.env`는 자동으로 빠집니다.
- `git stash create`는 작업 트리나 stash 목록을 건드리지 않고 **커밋하지 않은 수정(예: v2로 바꾼 `version.ts`)** 을 담은 임시 커밋만 만듭니다. 수정이 없으면 `HEAD`를 씁니다.
- zip 안에서 `package.json` · `Dockerfile`이 최상위에 옵니다(분석기가 단일 서비스로 인식하는 구조).
- 새로 만든 파일은 `git add` 해야 zip에 들어갑니다.

## 우리 분석기가 뽑는 IR (규칙 기반, AI 없이)

```jsonc
{
  "metadata": { "name": "sample-monolith", "version": "1.0.0" },
  "services": {
    "web": {                                  // docker-compose.yml 서비스 이름
      "type": "http",                         // dependencies.hono
      "build": { "dockerfile": "Dockerfile" },
      "command": ["node", "dist/server.js"],  // scripts.start
      "port": 3000,                           // Dockerfile EXPOSE
      "health": { "path": "/health", "expected_status": 200, "timeout_seconds": 3 },
      "env": ["APP_MESSAGE", "DEPLOY_TARGET", "PORT"]  // .env.example · process.env.*
    }
  }
}
```

`tests/e2e/samples.test.ts`가 이 결과를 검사합니다. 앱을 고칠 때 분석기가 계속 알아보도록 다음을 지켜 주세요.

- 환경변수는 `process.env.NAME` 형태로 읽고 `.env.example`에 적기 (`process.env["NAME"]`은 감지 안 됨)
- 포트는 `Dockerfile`의 `EXPOSE`로 감지됨 (TS 소스의 `listen(port)`는 감지 안 됨)
- HTTP 프레임워크(`hono`)를 `dependencies`에 유지 (없으면 서비스 유형을 규칙으로 못 정함)
