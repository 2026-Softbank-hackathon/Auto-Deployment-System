/**
 * apps/worker/src/static-site-publisher.ts
 *
 * 정적 사이트 AWS 배포 (#274) — 빌드한 이미지(같은 digest)에서 정적 파일을 꺼내 S3 버킷과 맞춘다.
 * 1. docker create(이미지 pull) → docker cp <컨테이너>:/usr/share/nginx/html → docker rm
 * 2. 버킷 목록과 비교해 내용(MD5 = ETag)이 바뀐 파일만 올린다. HTML 은 마지막에 올려
 *    새 HTML 이 아직 없는 파일을 가리키는 순간을 줄인다
 * 3. 이미지에 없는 파일은 지운다
 * 롤백 · 환경 전환은 예전 digest 로 같은 일을 다시 하면 된다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import {
  HASHED_FILE_PATTERN,
  NodeCommandRunner,
  STATIC_SITE_ROOT,
  type CommandRunner,
} from "@camellia/build-handler";
import { logMessage, type LogText } from "./log-messages.js";

type S3ClientLike = Pick<S3Client, "send">;

export type StaticSitePublisherOptions = {
  runner?: CommandRunner;
  s3Factory?: (
    region: string,
    credentials: { accessKeyId: string; secretAccessKey: string },
  ) => S3ClientLike;
  tempRoot?: string;
};

export type StaticSitePublishInput = {
  /** repository@sha256:... */
  imageRef: string;
  platform: "linux/amd64";
  /** Registry 로그인한 Docker 설정 (DOCKER_CONFIG) */
  commandEnvironment?: NodeJS.ProcessEnv;
  bucket: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  log?: (line: LogText) => Promise<void>;
};

export type StaticSitePublishResult = {
  uploaded: number;
  unchanged: number;
  deleted: number;
};

export class StaticSitePublishError extends Error {
  constructor(
    readonly code:
      | "STATIC_SITE_EXTRACT_FAILED"
      | "STATIC_SITE_INDEX_MISSING"
      | "STATIC_SITE_SYNC_FAILED",
    readonly detail?: string,
  ) {
    super(code);
    this.name = "StaticSitePublishError";
  }
}

export class StaticSitePublisher {
  private readonly runner: CommandRunner;
  private readonly s3Factory: NonNullable<StaticSitePublisherOptions["s3Factory"]>;
  private readonly tempRoot: string;

  constructor(options: StaticSitePublisherOptions = {}) {
    this.runner = options.runner ?? new NodeCommandRunner();
    this.s3Factory =
      options.s3Factory ?? ((region, credentials) => new S3Client({ region, credentials }));
    this.tempRoot = options.tempRoot ?? os.tmpdir();
  }

  async publish(input: StaticSitePublishInput): Promise<StaticSitePublishResult> {
    const directory = await fs.mkdtemp(path.join(this.tempRoot, "camellia-static-site-"));
    try {
      const siteDirectory = path.join(directory, "site");
      await fs.mkdir(siteDirectory);
      await this.extract(input, siteDirectory);

      const files = await listFiles(siteDirectory);
      if (!files.includes("index.html")) {
        throw new StaticSitePublishError("STATIC_SITE_INDEX_MISSING");
      }
      await input.log?.(logMessage("static.extracted", { count: files.length }));
      return await this.sync(input, siteDirectory, files);
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async extract(input: StaticSitePublishInput, destination: string): Promise<void> {
    let containerId: string | undefined;
    try {
      const created = await this.runner.run({
        command: "docker",
        args: ["create", "--platform", input.platform, input.imageRef],
        cwd: destination,
        env: input.commandEnvironment,
      });
      containerId = created.stdout.trim().split(/\s+/).at(-1);
      if (!containerId) throw new Error("container id missing");
      await this.runner.run({
        command: "docker",
        args: ["cp", `${containerId}:${STATIC_SITE_ROOT}/.`, destination],
        cwd: destination,
        env: input.commandEnvironment,
      });
    } catch (error) {
      throw new StaticSitePublishError(
        "STATIC_SITE_EXTRACT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (containerId) {
        await this.runner
          .run({
            command: "docker",
            args: ["rm", "-f", containerId],
            cwd: destination,
            env: input.commandEnvironment,
          })
          .catch(() => {});
      }
    }
  }

  private async sync(
    input: StaticSitePublishInput,
    siteDirectory: string,
    files: string[],
  ): Promise<StaticSitePublishResult> {
    const s3 = this.s3Factory(input.region, input.credentials);
    try {
      const existing = await listObjects(s3, input.bucket);
      // HTML 을 마지막에 올린다
      const ordered = [...files].sort(
        (a, b) => Number(isHtml(a)) - Number(isHtml(b)) || a.localeCompare(b),
      );
      let uploaded = 0;
      let unchanged = 0;
      for (const key of ordered) {
        const body = await fs.readFile(path.join(siteDirectory, ...key.split("/")));
        const etag = createHash("md5").update(body).digest("hex");
        if (existing.get(key) === etag) {
          unchanged += 1;
          continue;
        }
        await s3.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: key,
            Body: body,
            ContentType: contentTypeFor(key),
            CacheControl: cacheControlFor(key),
          }),
        );
        uploaded += 1;
      }

      const keep = new Set(files);
      const stale = [...existing.keys()].filter((key) => !keep.has(key));
      for (let index = 0; index < stale.length; index += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: input.bucket,
            Delete: {
              Objects: stale.slice(index, index + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
      }

      await input.log?.(
        logMessage("static.synced", { uploaded, unchanged, deleted: stale.length }),
      );
      return { uploaded, unchanged, deleted: stale.length };
    } catch (error) {
      if (error instanceof StaticSitePublishError) throw error;
      const name = (error as { name?: unknown }).name;
      throw new StaticSitePublishError(
        "STATIC_SITE_SYNC_FAILED",
        typeof name === "string" ? name : error instanceof Error ? error.message : undefined,
      );
    }
  }
}

/** key → ETag(따옴표 뺀 값) */
async function listObjects(s3: S3ClientLike, bucket: string): Promise<Map<string, string>> {
  const objects = new Map<string, string>();
  let token: string | undefined;
  do {
    const page = (await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )) as ListObjectsV2CommandOutput;
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.set(object.Key, (object.ETag ?? "").replace(/"/g, ""));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

/** 폴더 안 파일의 상대 경로('/' 구분). 심볼릭 링크는 따라가지 않는다 */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function isHtml(key: string): boolean {
  return /\.html?$/i.test(key);
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

export function contentTypeFor(key: string): string {
  const extension = key.split(".").at(-1)?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** 빌드 도구가 내용 해시를 붙인 파일 — 이미지의 nginx 설정과 같은 규칙 */
const HASHED_FILE = new RegExp(HASHED_FILE_PATTERN);

/**
 * 해시 붙은 파일만 오래 캐시하고, 나머지(HTML · version.js 등)는 매번 다시 확인한다 —
 * 재배포 · 롤백한 내용이 Cloudflare 캐시에 가려지지 않게.
 */
export function cacheControlFor(key: string): string {
  if (!isHtml(key) && HASHED_FILE.test(key)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

/**
 * 워커의 공인 IP — 버킷 정책이 Cloudflare 외에 이 IP 에서 직접 확인(검증)하는 요청도 받게 한다.
 * 실패하면 null (직접 검증이 403 으로 실패할 수 있다).
 */
export async function resolveEgressIp(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl("https://checkip.amazonaws.com", {
      signal: AbortSignal.timeout(3_000),
    });
    const text = (await response.text()).trim();
    const octets = text.split(".");
    if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}
