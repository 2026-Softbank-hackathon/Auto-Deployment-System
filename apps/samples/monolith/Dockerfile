# 빌드 스테이지: 의존성 설치 + 타입 검사(tsc) + esbuild 번들(의존성까지 dist/server.js 한 파일로)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 런타임 스테이지: alpine 패키지 nodejs(Node 24 LTS)와 번들 한 파일만 (npm · yarn · node_modules 없음)
# 공식 node 이미지의 실행 파일(ICU 전체 내장, 약 125MB) 대신 시스템 라이브러리를 공유하는 alpine 빌드를 써서
# Fargate 이미지 pull 시간을 줄인다
FROM alpine:3.24
RUN apk add --no-cache nodejs \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/server.js ./dist/server.js
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
