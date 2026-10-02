# 빌드 스테이지: 의존성 설치 + 타입 검사(tsc) + esbuild 번들(의존성까지 dist/server.cjs 한 파일로)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 런타임 스테이지: alpine 패키지 nodejs(Node 24, node:sqlite 내장)와 번들 한 파일 + SQLite 파일
FROM alpine:3.24
RUN apk add --no-cache nodejs \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /bin/sh -D node
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/server.cjs ./dist/server.cjs
# SQLite 는 파일 옆에 저널 파일을 만들므로 폴더째 node 사용자에게 준다
COPY --chown=node:node data ./data
USER node
EXPOSE 3000
CMD ["node", "dist/server.cjs"]
