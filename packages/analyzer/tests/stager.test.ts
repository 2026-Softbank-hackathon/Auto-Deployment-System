/**
 * packages/analyzer/tests/stager.test.ts
 *
 * stage() 단위 테스트 — dry-run 및 unzip 모드.
 * fixture zip은 beforeAll에서 Node 내장 zlib으로 생성한다 (외부 의존 없음).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { stage } from "../src/stager.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixturesDir = path.resolve(__dirname, "fixtures/zips");
const simpleZipPath = path.join(fixturesDir, "simple.zip");
const withSlipZipPath = path.join(fixturesDir, "with-slip.zip");

// ---------------------------------------------------------------------------
// Minimal ZIP builder (no external deps)
// Spec: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;
    const compressedSize = compressed.length;

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);  // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // compression: deflate
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);         // crc32
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    nameBytes.copy(local, 30);

    localHeaders.push(local);
    localHeaders.push(compressed);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(8, 10);          // compression
    central.writeUInt16LE(0, 12);          // mod time
    central.writeUInt16LE(0, 14);          // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);          // extra length
    central.writeUInt16LE(0, 32);          // comment length
    central.writeUInt16LE(0, 34);          // disk start
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);     // local header offset
    nameBytes.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // end-of-central-directory signature
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);       // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);      // total entries
  eocd.writeUInt32LE(centralDir.length, 12);   // central dir size
  eocd.writeUInt32LE(offset, 16);              // central dir offset
  eocd.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

/** CRC-32 implementation (ISO 3309 polynomial). */
function crc32(buf: Buffer): number {
  const table = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ (buf[i] as number)) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Fixture setup / teardown
// ---------------------------------------------------------------------------

let simpleZipSha256: string;
let simpleZipSize: number;

beforeAll(async () => {
  await mkdir(fixturesDir, { recursive: true });

  // simple.zip: server.js, package.json, README.md
  const simpleEntries: ZipEntry[] = [
    { name: "server.js", data: Buffer.from('const http = require("http"); http.createServer().listen(3000);') },
    { name: "package.json", data: Buffer.from('{"name":"test-app","version":"1.0.0"}') },
    { name: "README.md", data: Buffer.from("# Test App\nThis is a test.") },
  ];
  const simpleZipBuf = buildZip(simpleEntries);
  await writeFile(simpleZipPath, simpleZipBuf);

  simpleZipSize = simpleZipBuf.length;
  simpleZipSha256 = createHash("sha256").update(simpleZipBuf).digest("hex");

  // with-slip.zip: normal.txt + slip entry ../evil.txt
  const slipEntries: ZipEntry[] = [
    { name: "normal.txt", data: Buffer.from("safe content") },
    { name: "../evil.txt", data: Buffer.from("evil content") },
  ];
  const slipZipBuf = buildZip(slipEntries);
  await writeFile(withSlipZipPath, slipZipBuf);
});

afterAll(async () => {
  await rm(fixturesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// dry-run mode tests
// ---------------------------------------------------------------------------

describe("stage() — dry-run mode", () => {
  it("폴더 경로를 넘기면 resolvedPath를 그대로 반환한다", async () => {
    const fixture = path.resolve(__dirname, "fixtures/node-http");
    const result = await stage(fixture);
    expect(result.resolvedPath).toBe(fixture);
    expect(result.isDirectory).toBe(true);
  });

  it("기본 opts 없이 호출해도 dry-run으로 동작한다", async () => {
    const fixture = path.resolve(__dirname, "fixtures/node-http");
    const result = await stage(fixture, {});
    expect(result.resolvedPath).toBe(fixture);
  });

  it("mode='dry-run' 명시해도 동작이 동일하다", async () => {
    const fixture = path.resolve(__dirname, "fixtures/node-http");
    const result = await stage(fixture, { mode: "dry-run" });
    expect(result.resolvedPath).toBe(fixture);
  });

  it("존재하지 않는 경로면 throw한다", async () => {
    await expect(stage("/this/path/does/not/exist/at/all")).rejects.toThrow(
      "sourcePath not found"
    );
  });

  it("dry-run 모드에서 zip 파일 경로를 넘기면 throw한다", async () => {
    await expect(
      stage(simpleZipPath, { mode: "dry-run" })
    ).rejects.toThrow();
  });

  it("sha256, sizeBytes, cleanup은 undefined이다", async () => {
    const fixture = path.resolve(__dirname, "fixtures/node-http");
    const result = await stage(fixture);
    expect(result.sha256).toBeUndefined();
    expect(result.sizeBytes).toBeUndefined();
    expect(result.cleanup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// unzip mode tests
// ---------------------------------------------------------------------------

describe("stage() — unzip mode", () => {
  it("zip 파일을 해제하고 resolvedPath(destDir)를 반환한다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    try {
      const s = await stat(result.resolvedPath);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await result.cleanup?.();
    }
  });

  it("해제된 폴더에 server.js가 존재한다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    try {
      const content = await readFile(
        path.join(result.resolvedPath, "server.js"),
        "utf8"
      );
      expect(content).toContain("listen(3000)");
    } finally {
      await result.cleanup?.();
    }
  });

  it("sha256가 미리 계산한 값과 일치한다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    try {
      expect(result.sha256).toBe(simpleZipSha256);
    } finally {
      await result.cleanup?.();
    }
  });

  it("sizeBytes가 zip 파일 크기와 일치한다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    try {
      expect(result.sizeBytes).toBe(simpleZipSize);
    } finally {
      await result.cleanup?.();
    }
  });

  it("cleanup() 호출 후 destDir가 삭제된다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    const destDir = result.resolvedPath;
    await result.cleanup!();
    await expect(stat(destDir)).rejects.toThrow();
  });

  it("destDir 명시 시 그 폴더에 해제된다", async () => {
    const customDest = path.join(os.tmpdir(), `stager-test-custom-${Date.now()}`);
    try {
      const result = await stage(simpleZipPath, {
        mode: "unzip",
        destDir: customDest,
      });
      expect(result.resolvedPath).toBe(customDest);
      const s = await stat(customDest);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(customDest, { recursive: true, force: true });
    }
  });

  it("README.md 내용이 올바르게 해제된다", async () => {
    const result = await stage(simpleZipPath, { mode: "unzip" });
    try {
      const content = await readFile(
        path.join(result.resolvedPath, "README.md"),
        "utf8"
      );
      expect(content).toContain("Test App");
    } finally {
      await result.cleanup?.();
    }
  });
});

// ---------------------------------------------------------------------------
// zip slip 방지 테스트
// ---------------------------------------------------------------------------

describe("stage() — zip slip 방지", () => {
  it("../ 포함 엔트리를 skip하고 정상 엔트리는 해제한다", async () => {
    const result = await stage(withSlipZipPath, { mode: "unzip" });
    try {
      // 안전한 normal.txt는 해제되어야 한다
      const content = await readFile(
        path.join(result.resolvedPath, "normal.txt"),
        "utf8"
      );
      expect(content).toBe("safe content");

      // evil.txt는 destDir 밖으로 탈출하므로 존재하지 않아야 한다
      await expect(
        stat(path.join(result.resolvedPath, "../evil.txt"))
      ).rejects.toThrow();
    } finally {
      await result.cleanup?.();
    }
  });

  it("zip slip 시도 후에도 cleanup()이 정상 동작한다", async () => {
    const result = await stage(withSlipZipPath, { mode: "unzip" });
    const destDir = result.resolvedPath;
    await result.cleanup!();
    await expect(stat(destDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 대량 파일 테스트 (100개 이상)
// ---------------------------------------------------------------------------

describe("stage() — 대량 파일 해제", () => {
  it("100개 파일을 모두 해제한다", async () => {
    const entries: ZipEntry[] = Array.from({ length: 100 }, (_, i) => ({
      name: `file-${i.toString().padStart(3, "0")}.txt`,
      data: Buffer.from(`content of file ${i}`),
    }));
    const bulkZip = buildZip(entries);
    const bulkZipPath = path.join(fixturesDir, "bulk.zip");
    await writeFile(bulkZipPath, bulkZip);

    const result = await stage(bulkZipPath, { mode: "unzip" });
    try {
      // 모든 파일이 해제되었는지 확인
      for (let i = 0; i < 100; i++) {
        const fname = `file-${i.toString().padStart(3, "0")}.txt`;
        const content = await readFile(
          path.join(result.resolvedPath, fname),
          "utf8"
        );
        expect(content).toBe(`content of file ${i}`);
      }
    } finally {
      await result.cleanup?.();
      await rm(bulkZipPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 역슬래시 엔트리 (Windows PowerShell 5.1 Compress-Archive 등이 만드는 zip)
// ---------------------------------------------------------------------------

describe("stage() — 역슬래시 구분 엔트리", () => {
  it("src\\server.js 엔트리를 OS 와 무관하게 src/server.js 로 해제한다", async () => {
    const zipPath = path.join(fixturesDir, "backslash.zip");
    await writeFile(zipPath, buildZip([
      { name: "src\\server.js", data: Buffer.from("listen(3000)") },
    ]));

    const result = await stage(zipPath, { mode: "unzip" });
    try {
      const content = await readFile(path.join(result.resolvedPath, "src", "server.js"), "utf8");
      expect(content).toBe("listen(3000)");
    } finally {
      await result.cleanup?.();
      await rm(zipPath, { force: true });
    }
  });
});
