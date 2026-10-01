# syntax=docker/dockerfile:1.7
#
# apps/api — Fastify API 서버. 같은 이미지로 DB 마이그레이션(one-shot)도 실행한다.
# 빌드 컨텍스트는 리포 루트 (pnpm workspace).
#   docker build --platform linux/amd64 -f apps/api/Dockerfile -t camellia-api .
#
# 런타임은 dev와 같은 tsx(TypeScript 직접 실행). workspace 패키지가 src/*.ts 를
# export 하므로 별도 컴파일 단계 없이 그대로 실행한다.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY . .
# api 와 그 workspace 의존성만, prod 의존성만 설치. pnpm store 는 BuildKit 캐시로 재사용
# (pnpm fetch 는 워크스페이스 전체를 node_modules/.pnpm 에 풀어 이미지가 커져서 쓰지 않는다)
RUN --mount=type=cache,id=camellia-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@camellia/api..."

FROM ${NODE_IMAGE} AS runtime
# tsx 는 api 의 devDependency 라 --prod 설치에서 빠진다 → lockfile 과 같은 버전을 전역 설치
ARG TSX_VERSION=4.23.15
RUN npm install -g "tsx@${TSX_VERSION}" && npm cache clean --force
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORAGE_ROOT_DIR=/data/storage
COPY --from=deps /repo /repo
# 업로드 소스 · 로그 등 로컬 오브젝트 스토리지 (worker 와 같은 볼륨을 공유)
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
WORKDIR /repo/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1
CMD ["tsx", "src/main.ts"]
