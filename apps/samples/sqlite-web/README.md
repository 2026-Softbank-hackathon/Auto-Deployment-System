# sample-sqlite-web — SQLite 를 쓰는 방명록 샘플

DB 전환 기능(SQLite 앱을 AWS 에서는 PostgreSQL 로 실행)을 확인하려고 만든 작은 앱입니다. 데이터는 저장소에 들어 있는 SQLite 파일 `data/guestbook.db` 하나에 있고, 처음 글 3개가 들어 있습니다.

- Node 24 + TypeScript + [Hono](https://hono.dev), SQLite 는 Node 내장 `node:sqlite` 를 써서 네이티브 모듈 빌드가 없습니다.
- 독립 프로젝트입니다. 자체 `package.json` · `package-lock.json`(npm)이 있고 이 폴더만 zip 으로 올려도 `docker build` 가 됩니다.
- 런타임 이미지는 monolith 샘플과 같이 `alpine:3.24` + alpine 패키지 `nodejs` 에 번들 한 파일(`dist/server.cjs`)과 `data/` 만 넣습니다.

## 화면 · API

| 경로 | 응답 |
|---|---|
| `GET /` | 방명록 화면. 위쪽에 지금 쓰는 저장소(SQLite / PostgreSQL)와 글 수를 보여 줍니다 |
| `POST /api/entries` | 글 남기기 (`name`, `message` 폼 또는 JSON) |
| `GET /api/entries` | 글 목록 JSON |
| `GET /health` | DB 에 `SELECT 1` 을 해 보고 되면 200, 안 되면 503 |

## 배포하면 어떻게 되나

분석기가 `node:sqlite` 사용을 찾아 IR 에 PostgreSQL 리소스(`DATABASE_URL`)를 넣고, PostgreSQL 을 쓰도록 바꾼 코드 수정안을 만듭니다. 승인하면 수정된 코드로 이미지를 한 번 빌드합니다.

- AWS: RDS PostgreSQL 이 함께 만들어지고 앱은 `DATABASE_URL` 로 접속합니다. 처음 뜰 때 Postgres 가 비어 있으면 이미지에 들어 있는 `data/guestbook.db` 의 글을 옮겨 옵니다.
- 온프레미스: 같은 이미지가 `DATABASE_URL` 없이 실행되어 지금처럼 SQLite 파일을 씁니다. 컨테이너를 새로 띄우면 그 사이에 쓴 글은 사라집니다(볼륨 없음).

## 로컬 실행

```bash
npm ci
npm run build          # tsc 타입 검사 → esbuild 번들(dist/server.cjs)
npm start              # http://localhost:3000
```

## 업로드용 zip 만들기

저장소 루트에서 실행합니다.

```bash
git archive --format=zip -o "$HOME/sample-sqlite-web.zip" HEAD:apps/samples/sqlite-web
```
