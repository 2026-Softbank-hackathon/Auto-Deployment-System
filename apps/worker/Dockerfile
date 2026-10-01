# syntax=docker/dockerfile:1.7
#
# apps/worker — pg-boss 작업 핸들러 (analyze · build · provision · verify).
# 빌드 컨텍스트는 리포 루트 (pnpm workspace).
#   docker build --platform linux/amd64 -f apps/worker/Dockerfile -t camellia-worker .
#
# 런타임 외부 도구:
#   - docker CLI + buildx : 사용자 앱 빌드 (호스트 /var/run/docker.sock 사용)
#   - railpack            : Dockerfile 없는 앱 빌드 (BUILDKIT_HOST 의 buildkitd 사용)
#   - terraform           : 사용자 계정 프로비저닝 (infra/terraform/profiles 복사 후 실행)
#   - git                 : terraform git 모듈 소스용
# worker 는 리포 루트 기준 infra/terraform/profiles 를 찾으므로 /repo 구조를 그대로 둔다.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY . .
# worker 와 그 workspace 의존성만, prod 의존성만 설치. pnpm store 는 BuildKit 캐시로 재사용
RUN --mount=type=cache,id=camellia-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@camellia/worker..."

FROM alpine:3.22 AS tools
ARG TERRAFORM_VERSION=1.16.4
ARG RAILPACK_VERSION=0.40.1
RUN apk add --no-cache curl unzip
WORKDIR /tools
# terraform: HashiCorp 공식 SHA256SUMS 로 무결성 확인
RUN curl -fsSLO "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
 && curl -fsSLO "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \
 && grep " terraform_${TERRAFORM_VERSION}_linux_amd64.zip\$" "terraform_${TERRAFORM_VERSION}_SHA256SUMS" | sha256sum -c - \
 && unzip -q "terraform_${TERRAFORM_VERSION}_linux_amd64.zip" terraform
RUN curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C /tools railpack

FROM ${NODE_IMAGE} AS runtime
ARG TSX_VERSION=4.23.15
# docker-cli-buildx 는 /usr/libexec/docker/cli-plugins 에 설치된다. worker 가 빌드마다
# DOCKER_CONFIG 를 임시 디렉터리로 바꿔도 시스템 플러그인 경로라 그대로 찾는다.
RUN apk add --no-cache docker-cli docker-cli-buildx git ca-certificates \
 && npm install -g "tsx@${TSX_VERSION}" && npm cache clean --force
COPY --from=tools /tools/terraform /tools/railpack /usr/local/bin/
ENV NODE_ENV=production \
    STORAGE_ROOT_DIR=/data/storage \
    TERRAFORM_BINARY=/usr/local/bin/terraform
COPY --from=deps /repo /repo
RUN mkdir -p /data/storage && chown node:node /data/storage
# docker.sock 접근은 compose 의 group_add(호스트 docker 그룹 GID)로 부여한다
USER node
WORKDIR /repo/apps/worker
CMD ["tsx", "src/main.ts"]
