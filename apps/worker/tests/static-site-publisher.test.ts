import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { CommandRequest } from "@camellia/build-handler";
import {
  StaticSitePublishError,
  StaticSitePublisher,
  cacheControlFor,
  contentTypeFor,
  resolveEgressIp,
} from "../src/static-site-publisher.js";
import { renderLogText } from "../src/log-messages.js";

const IMAGE = `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/1@sha256:${"c".repeat(64)}`;

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/** docker create/cp/rm 흉내 — cp 대상 폴더에 files 를 쓴다 */
function fakeDocker(files: Record<string, string>) {
  const calls: CommandRequest[] = [];
  const runner = {
    run: vi.fn(async (request: CommandRequest) => {
      calls.push(request);
      if (request.args[0] === "create") return { stdout: "container-123\n", stderr: "" };
      if (request.args[0] === "cp") {
        const destination = request.args[2]!;
        for (const [name, content] of Object.entries(files)) {
          const target = path.join(destination, name);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
        }
      }
      return { stdout: "", stderr: "" };
    }),
  };
  return { runner, calls };
}

function fakeS3(existing: Record<string, string> = {}) {
  const commands: unknown[] = [];
  const client = {
    send: vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: Object.entries(existing).map(([Key, content]) => ({ Key, ETag: `"${md5(content)}"` })),
          IsTruncated: false,
        };
      }
      return {};
    }),
  };
  return { client, commands, factory: vi.fn(() => client) };
}

const credentials = { accessKeyId: "AKIA", secretAccessKey: "secret" };

describe("StaticSitePublisher (#274)", () => {
  it("이미지에서 파일을 꺼내 버킷과 맞춘다 — 바뀐 파일만 올리고 HTML 은 마지막, 없어진 파일은 지운다", async () => {
    const { runner, calls } = fakeDocker({
      "index.html": "<html>v2</html>",
      "assets/index-B4ZSS1DM.js": "console.log(2)",
      "css/site.css": "body{}",
    });
    const s3 = fakeS3({ "css/site.css": "body{}", "assets/index-OLDHASH1.js": "old", "index.html": "<html>v1</html>" });
    const lines: string[] = [];

    const result = await new StaticSitePublisher({ runner, s3Factory: s3.factory }).publish({
      imageRef: IMAGE,
      platform: "linux/amd64",
      commandEnvironment: { DOCKER_CONFIG: "/tmp/docker" },
      bucket: "service-1.camellia.example.com",
      region: "ap-northeast-2",
      credentials,
      log: async (line) => {
        lines.push(renderLogText(line));
      },
    });

    expect(result).toEqual({ uploaded: 2, unchanged: 1, deleted: 1 });
    expect(s3.factory).toHaveBeenCalledWith("ap-northeast-2", credentials);

    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["create", "--platform", "linux/amd64"],
      ["cp", "container-123:/usr/share/nginx/html/.", expect.any(String)],
      ["rm", "-f", "container-123"],
    ]);
    expect(calls[0]!.args.at(-1)).toBe(IMAGE);
    expect(calls.every((call) => call.env?.["DOCKER_CONFIG"] === "/tmp/docker")).toBe(true);

    const puts = s3.commands.filter((c): c is PutObjectCommand => c instanceof PutObjectCommand);
    expect(puts.map((put) => put.input.Key)).toEqual(["assets/index-B4ZSS1DM.js", "index.html"]);
    expect(puts[0]!.input).toMatchObject({
      Bucket: "service-1.camellia.example.com",
      ContentType: "text/javascript; charset=utf-8",
      CacheControl: "public, max-age=31536000, immutable",
    });
    expect(puts[1]!.input).toMatchObject({ ContentType: "text/html; charset=utf-8", CacheControl: "no-cache" });

    const deletes = s3.commands.filter((c): c is DeleteObjectsCommand => c instanceof DeleteObjectsCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.Delete?.Objects).toEqual([{ Key: "assets/index-OLDHASH1.js" }]);
    expect(lines.join("\n")).toContain("올림 2");
  });

  it("index.html 이 없으면 버킷을 건드리지 않고 실패한다", async () => {
    const { runner, calls } = fakeDocker({ "about.html": "x" });
    const s3 = fakeS3();

    await expect(
      new StaticSitePublisher({ runner, s3Factory: s3.factory }).publish({
        imageRef: IMAGE,
        platform: "linux/amd64",
        bucket: "service-1.camellia.example.com",
        region: "ap-northeast-2",
        credentials,
      }),
    ).rejects.toMatchObject({ code: "STATIC_SITE_INDEX_MISSING" });
    expect(s3.client.send).not.toHaveBeenCalled();
    // 실패해도 꺼낼 때 만든 컨테이너는 지운다
    expect(calls.at(-1)?.args).toEqual(["rm", "-f", "container-123"]);
  });

  it("이미지를 꺼내지 못하면 STATIC_SITE_EXTRACT_FAILED", async () => {
    const runner = { run: vi.fn(async () => Promise.reject(new Error("pull denied"))) };
    const s3 = fakeS3();
    const error = await new StaticSitePublisher({ runner, s3Factory: s3.factory })
      .publish({
        imageRef: IMAGE,
        platform: "linux/amd64",
        bucket: "service-1.camellia.example.com",
        region: "ap-northeast-2",
        credentials,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaticSitePublishError);
    expect(error).toMatchObject({ code: "STATIC_SITE_EXTRACT_FAILED" });
  });
});

describe("콘텐츠 타입 · 캐시 헤더", () => {
  it("확장자별 콘텐츠 타입", () => {
    expect(contentTypeFor("a/b.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("data.bin")).toBe("application/octet-stream");
  });

  it("해시가 붙은 파일만 오래 캐시하고 나머지는 매번 다시 확인한다 (재배포가 캐시에 가려지지 않게)", () => {
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("docs/page.htm")).toBe("no-cache");
    expect(cacheControlFor("static/js/main.3f2a1b4c.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("js/app-settings.js")).toBe("no-cache");
    expect(cacheControlFor("version.js")).toBe("no-cache");
    expect(cacheControlFor("css/site.css")).toBe("no-cache");
  });
});

describe("resolveEgressIp", () => {
  it("checkip 응답의 IPv4 를 돌려주고, 이상한 응답이나 실패는 null", async () => {
    expect(await resolveEgressIp(async () => new Response("203.0.113.7\n"))).toBe("203.0.113.7");
    expect(await resolveEgressIp(async () => new Response("<html>"))).toBeNull();
    expect(await resolveEgressIp(async () => Promise.reject(new Error("offline")))).toBeNull();
  });
});
