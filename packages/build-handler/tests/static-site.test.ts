import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuildHandler,
  HASHED_FILE_PATTERN,
  renderStaticSiteDockerfile,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../src/index.js";

const DIGEST = `sha256:${"b".repeat(64)}`;

/** buildx 호출 때 생성된 Dockerfile · dockerignore 를 읽어 두고 digest 메타데이터를 쓴다 */
class CapturingRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  dockerfile = "";
  dockerignore = "";
  dockerfilePath = "";

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    const fileIndex = request.args.indexOf("--file");
    this.dockerfilePath = request.args[fileIndex + 1]!;
    this.dockerfile = await fs.readFile(this.dockerfilePath, "utf8");
    this.dockerignore = await fs.readFile(`${this.dockerfilePath}.dockerignore`, "utf8");
    const metadataPath = request.args[request.args.indexOf("--metadata-file") + 1]!;
    await fs.writeFile(metadataPath, JSON.stringify({ "containerimage.digest": DIGEST }));
    return { stdout: "", stderr: "" };
  }
}

describe("정적 사이트 이미지 빌드 (#273)", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "camellia-static-build-"));
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("빌드 명령이 있으면 node 단계에서 빌드하고 결과 폴더만 nginx 이미지에 담아 push 한다", async () => {
    const runner = new CapturingRunner();
    const canonicalWorkspace = await fs.realpath(workspacePath);

    const result = await new BuildHandler({ runner }).build({
      workspacePath,
      plan: {
        context: ".",
        staticSite: { buildCommand: "npm run build", outputDir: "dist", spaFallback: true, listenPort: 8080 },
      },
      image: { repository: "registry.example.com/camellia/site", tag: "v1" },
    });

    expect(result.image.digest).toBe(DIGEST);
    expect(result.strategy).toBe("dockerfile");
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]!.args;
    expect(args).toEqual(expect.arrayContaining(["buildx", "build", "--platform", "linux/amd64", "--push"]));
    expect(args.at(-1)).toBe(canonicalWorkspace);
    // 생성한 Dockerfile 은 사용자 소스 밖에 두고, 빌드가 끝나면 지운다
    expect(path.relative(canonicalWorkspace, runner.dockerfilePath).startsWith("..")).toBe(true);
    await expect(fs.stat(runner.dockerfilePath)).rejects.toThrow();

    expect(runner.dockerfile).toContain("FROM node:22-alpine AS build");
    expect(runner.dockerfile).toContain('RUN ["sh","-c","npm run build"]');
    expect(runner.dockerfile).toContain("COPY --from=build /app/dist/ /usr/share/nginx/html/");
    expect(runner.dockerfile).toContain("FROM nginx:1.27-alpine");
    expect(runner.dockerfile).toContain("EXPOSE 8080");
    expect(runner.dockerignore).toContain("node_modules");
    // 빌드 단계는 .env 를 읽을 수 있어야 한다 (최종 이미지에는 결과 폴더만 들어감)
    expect(runner.dockerignore).not.toContain(".env");
  });

  it("빌드 명령이 없으면 소스를 그대로 담고 .env · Dockerfile 은 빼서 공개되지 않게 한다", async () => {
    const runner = new CapturingRunner();
    await new BuildHandler({ runner }).build({
      workspacePath,
      plan: { context: ".", staticSite: { outputDir: ".", spaFallback: false, listenPort: 8080 } },
      image: { repository: "registry.example.com/camellia/site", tag: "v2" },
    });

    expect(runner.dockerfile).not.toContain("AS build");
    expect(runner.dockerfile).toContain("COPY ./ /usr/share/nginx/html/");
    expect(runner.dockerignore).toMatch(/^\.env$/m);
    expect(runner.dockerignore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(runner.dockerignore).toMatch(/^\.git$/m);
  });

  it("빌드 없이 하위 폴더를 서빙하면 그 폴더가 소스 안에 있어야 한다", async () => {
    const runner = new CapturingRunner();
    await expect(
      new BuildHandler({ runner }).build({
        workspacePath,
        plan: { context: ".", staticSite: { outputDir: "public", spaFallback: true, listenPort: 8080 } },
        image: { repository: "registry.example.com/camellia/site", tag: "v3" },
      }),
    ).rejects.toMatchObject({ code: "BUILD_CONTEXT_NOT_FOUND" });
    expect(runner.calls).toHaveLength(0);
  });

  it("여러 줄 빌드 명령 · 소스 밖 결과 폴더 · 잘못된 포트는 실행 전에 거부한다", async () => {
    const runner = new CapturingRunner();
    const handler = new BuildHandler({ runner });
    const image = { repository: "registry.example.com/camellia/site", tag: "v4" };
    for (const staticSite of [
      { buildCommand: "npm run build\nRUN curl x", outputDir: "dist", spaFallback: true, listenPort: 8080 },
      { buildCommand: "npm run build", outputDir: "../dist", spaFallback: true, listenPort: 8080 },
      { buildCommand: "npm run build", outputDir: "/dist", spaFallback: true, listenPort: 8080 },
      { buildCommand: "npm run build", outputDir: "dist", spaFallback: true, listenPort: 70000 },
    ]) {
      await expect(
        handler.build({ workspacePath, plan: { context: ".", staticSite }, image }),
      ).rejects.toMatchObject({ code: "INVALID_BUILD_REQUEST" });
    }
    expect(runner.calls).toHaveLength(0);
  });
});

describe("renderStaticSiteDockerfile — nginx 설정", () => {
  it("SPA fallback 이면 없는 경로를 index.html 로, 아니면 404", () => {
    const spa = renderStaticSiteDockerfile({ outputDir: ".", spaFallback: true, listenPort: 8080 });
    expect(spa).toContain("try_files $uri $uri/ /index.html;");
    const mpa = renderStaticSiteDockerfile({ outputDir: ".", spaFallback: false, listenPort: 9000 });
    expect(mpa).toContain("try_files $uri $uri/ =404;");
    expect(mpa).toContain("listen 9000;");
    expect(mpa).toContain("EXPOSE 9000");
  });

  it("해시 없는 파일은 캐시하지 않고 해시 붙은 파일만 오래 캐시, 리다이렉트는 포트 없는 상대 주소로 (Tunnel · 프록시 뒤)", () => {
    const dockerfile = renderStaticSiteDockerfile({ outputDir: ".", spaFallback: true, listenPort: 8080 });
    expect(dockerfile).toContain("absolute_redirect off;");
    expect(dockerfile).toContain(`'        add_header Cache-Control "no-cache";'`);
    expect(dockerfile).toContain(`'        add_header Cache-Control "public, max-age=31536000, immutable";'`);
    const pattern = new RegExp(HASHED_FILE_PATTERN);
    expect(pattern.test("/assets/index-B4ZSS1DM.js")).toBe(true);
    expect(pattern.test("/static/js/main.3f2a1b4c.js")).toBe(true);
    expect(pattern.test("/version.js")).toBe(false);
    expect(pattern.test("/js/app-settings.js")).toBe(false);
  });
});
