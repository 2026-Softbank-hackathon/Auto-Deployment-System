/**
 * 정적 사이트 이미지 (#273) — 빌드 결과를 nginx(alpine) 이미지 하나에 담는다.
 * 같은 이미지(같은 digest)를 온프레미스에서는 컨테이너로 실행하고, AWS 에서는 파일을 꺼내 S3 에 올린다.
 * 이미지 안 파일 위치는 STATIC_SITE_ROOT 로 고정 — provision 이 여기서 파일을 꺼낸다.
 */
import type { StaticSiteBuildPlan } from "@camellia/adapters";
import { BuildError } from "./errors.js";

export const STATIC_SITE_ROOT = "/usr/share/nginx/html";

const NODE_IMAGE = "node:22-alpine";
const NGINX_IMAGE = "nginx:1.27-alpine";

const SAFE_RELATIVE_DIR = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * 빌드 도구가 내용 해시를 붙인 파일 (예: index-B4ZSS1DM.js, main.3f2a1b4c.css) — 숫자가 섞인 8자 이상.
 * nginx 설정과 S3 동기화(worker)가 같은 규칙으로 캐시 헤더를 정한다.
 */
export const HASHED_FILE_PATTERN = "[.-](?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{8,}\\.[A-Za-z0-9]+$";

/** lock 파일에 맞는 의존성 설치 (빌드 단계) */
const INSTALL_DEPENDENCIES =
  "if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile; " +
  "elif [ -f yarn.lock ]; then corepack enable && yarn install; " +
  "elif [ -f package-lock.json ]; then npm ci; " +
  "else npm install; fi";

const PACKAGE_CACHE_MOUNTS = [
  "--mount=type=cache,id=camellia-static-npm,target=/root/.npm",
  "--mount=type=cache,id=camellia-static-pnpm,target=/root/.local/share/pnpm/store",
  "--mount=type=cache,id=camellia-static-yarn,target=/usr/local/share/.cache/yarn",
].join(" ");

/** 빌드 단계 context 에서 뺄 것 — 결과 폴더만 최종 이미지에 들어가므로 .env 는 빌드가 읽게 둔다 */
const BUILD_IGNORE = [".git", "**/.git", "node_modules", "**/node_modules"];

/** 소스를 그대로 서빙할 때 공개되면 안 되는 것 */
const SERVE_AS_IS_IGNORE = [
  ...BUILD_IGNORE,
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "Dockerfile",
  "Dockerfile.*",
  ".dockerignore",
];

export type NormalizedStaticSite = StaticSiteBuildPlan & { outputDir: string };

/** 실행 전에 값 검증 — 생성할 Dockerfile 에 그대로 들어가는 값이다 */
export function normalizeStaticSite(site: StaticSiteBuildPlan): NormalizedStaticSite {
  const outputDir = site.outputDir.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const segments = outputDir.split("/");
  if (
    outputDir !== "." &&
    (!SAFE_RELATIVE_DIR.test(outputDir) || segments.includes("..") || segments.includes("."))
  ) {
    throw new BuildError("INVALID_BUILD_REQUEST", "정적 사이트 결과 폴더는 소스 안의 상대 경로여야 합니다.");
  }
  if (site.buildCommand !== undefined && !/^[^\r\n\0]{1,500}$/.test(site.buildCommand)) {
    throw new BuildError("INVALID_BUILD_REQUEST", "정적 사이트 빌드 명령은 한 줄이어야 합니다.");
  }
  if (!Number.isInteger(site.listenPort) || site.listenPort < 1 || site.listenPort > 65535) {
    throw new BuildError("INVALID_BUILD_REQUEST", "정적 사이트 포트가 올바르지 않습니다.");
  }
  return { ...site, outputDir };
}

export function renderStaticSiteDockerfile(input: StaticSiteBuildPlan): string {
  const site = normalizeStaticSite(input);
  const sourceDir = site.outputDir === "." ? "./" : `${site.outputDir}/`;
  const nginxConfig = [
    "server {",
    `    listen ${site.listenPort};`,
    "    server_name _;",
    `    root ${STATIC_SITE_ROOT};`,
    "    index index.html;",
    // Tunnel · 프록시 뒤라 리다이렉트에 컨테이너 포트가 붙지 않게 상대 주소로
    "    absolute_redirect off;",
    // 해시 없는 파일(HTML · version.js 등)은 매번 다시 확인 — 재배포가 Cloudflare 캐시에 가려지지 않게
    "    location / {",
    '        add_header Cache-Control "no-cache";',
    site.spaFallback ? "        try_files $uri $uri/ /index.html;" : "        try_files $uri $uri/ =404;",
    "    }",
    // 빌드 도구가 내용 해시를 붙인 파일은 오래 캐시 (S3 동기화와 같은 규칙)
    `    location ~ "${HASHED_FILE_PATTERN}" {`,
    '        add_header Cache-Control "public, max-age=31536000, immutable";',
    "        try_files $uri =404;",
    "    }",
    "}",
  ];

  const lines = ["# Camellia 정적 사이트 이미지 — 빌드 결과를 nginx 로 서빙"];
  if (site.buildCommand) {
    lines.push(
      `FROM ${NODE_IMAGE} AS build`,
      "WORKDIR /app",
      "COPY . .",
      // 패키지 캐시는 BuildKit 캐시로 다음 빌드에 재사용 (npm · pnpm · yarn)
      `RUN ${PACKAGE_CACHE_MOUNTS} ${INSTALL_DEPENDENCIES}`,
      // exec 형식(JSON) — 명령 문자열이 Dockerfile 지시어로 해석되지 않는다
      `RUN ${JSON.stringify(["sh", "-c", site.buildCommand])}`,
      "",
    );
  }
  lines.push(
    `FROM ${NGINX_IMAGE}`,
    `RUN rm -rf ${STATIC_SITE_ROOT}/* && printf '%s\\n' ${nginxConfig
      .map((line) => `'${line}'`)
      .join(" ")} > /etc/nginx/conf.d/default.conf`,
    site.buildCommand
      ? `COPY --from=build /app/${sourceDir} ${STATIC_SITE_ROOT}/`
      : `COPY ${sourceDir} ${STATIC_SITE_ROOT}/`,
    `EXPOSE ${site.listenPort}`,
    "",
  );
  return lines.join("\n");
}

/** Dockerfile 옆에 두는 `<Dockerfile>.dockerignore` (BuildKit) — 사용자 .dockerignore 는 건드리지 않는다 */
export function renderStaticSiteDockerignore(site: StaticSiteBuildPlan): string {
  return `${(site.buildCommand ? BUILD_IGNORE : SERVE_AS_IS_IGNORE).join("\n")}\n`;
}
