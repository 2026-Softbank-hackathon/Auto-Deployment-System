# Camellia — AI 원클릭 멀티 환경 배포 시스템

SoftBank Hackathon 2026 · team camellia · One Action, Infinite Clouds.

## 로컬 개발

전제: Node 20+, pnpm 9+, Docker Desktop

```bash
# 1. 의존성 설치
pnpm install

# 2. Postgres 컨테이너 기동 (백그라운드)
pnpm db:up

# 3. DB 마이그레이션
pnpm db:migrate

# 4. 로컬 개발 서버 (api + worker 동시 실행)
pnpm dev
```

## 디렉토리

- `docs/` — 아키텍처, 결정, 회의록, 명세
- `packages/` — 라이브러리 (ir-schema, analyzer, profiles, profile-matcher, db, storage)
- `apps/` — 실행 애플리케이션 (api, worker)
- `.omc/` — Claude Code 로컬 아티팩트 (git-ignored)

## 주요 문서

- `docs/architecture-v5.md` — 아키텍처 v5.4.1
- `docs/functional-spec-v3.md` — 기능 명세 (P0/P1/P2)
- `docs/api-spec-v0.md` — REST API 명세
- `docs/ir-schema-v0.md` — IR 스키마 설명
- `docs/decisions.md` — 결정 기록 (D-01~)
- `docs/integration-guide.md` — 개발 가이드 (TS 사전지식 포함)

## 테스트

```bash
pnpm -r test               # 전체 workspace 테스트
pnpm --filter @camellia/ir-schema test  # 특정 패키지
```

## 라이선스

미정 (해커톤 프로젝트).
