# syntax=docker/dockerfile:1.7
#
# apps/web — Vite 정적 빌드 + nginx (정적 파일 · /api/ · /docs 리버스 프록시).
# 빌드 컨텍스트는 리포 루트 (pnpm workspace).
#   docker build --platform linux/amd64 -f apps/web/Dockerfile -t camellia-web .
#
# 런타임 env (nginx 설정 렌더링):
#   API_UPSTREAM                  API 주소 (기본 api:3000)
#   PLATFORM_API_KEY              API 로 넘길 X-API-Key (= api 의 API_KEY)
#   CONSOLE_BASIC_AUTH_USER/PASSWORD  콘솔 Basic Auth 계정
#   CONSOLE_BASIC_AUTH=off        Basic Auth 끄기 (로컬 전용)

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=camellia-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter camellia-web
# 같은 origin 의 nginx 가 /api/v1 을 프록시하므로 상대 경로 그대로 사용
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_DEMO_TARGET=aws
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_DEMO_TARGET=${VITE_DEMO_TARGET}
RUN pnpm --filter camellia-web build

FROM nginxinc/nginx-unprivileged:1.28-alpine AS runtime
USER root
# Basic Auth 비밀번호 해시(apr1)용
RUN apk add --no-cache openssl \
 && mkdir -p /etc/nginx/auth \
 && chown nginx:nginx /etc/nginx/auth
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY apps/web/nginx/api-proxy.conf /etc/nginx/snippets/api-proxy.conf
COPY --chmod=755 apps/web/nginx/12-camellia-auth.envsh /docker-entrypoint.d/12-camellia-auth.envsh
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
USER nginx
ENV API_UPSTREAM=api:3000 \
    NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|PLATFORM_API_KEY|CONSOLE_AUTH_REALM)$"
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
