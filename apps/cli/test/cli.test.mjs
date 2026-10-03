import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseArgs, splitBooleanFlags } from "../src/args.mjs";
import { renderBody, renderPath, renderQuery } from "../src/template.mjs";
import { crc32, zipDirectory } from "../src/zip.mjs";
import { displayWidth, fillMessage } from "../src/output.mjs";

const app = { resolved: { id: "7", name: "shop", live: { deploymentId: "42" } }, valueField: "id" };

test("인자 — 위치 인자 · --k v · --k=v · 값 없는 전역 플래그", () => {
  const { rest, flags: global } = splitBooleanFlags(["deploy", "--yes", "shop", "./src", "--to=aws-1", "--mode", "container", "--json"]);
  assert.deepEqual(global, { yes: true, json: true });
  assert.deepEqual(parseArgs(rest), { positionals: ["deploy", "shop", "./src"], flags: { to: "aws-1", mode: "container" } });
});

test("경로 — resolver 객체는 대표 필드, 점 경로는 하위 필드", () => {
  assert.equal(renderPath("/projects/{app}/env", { app }), "/projects/7/env");
  assert.equal(renderPath("/deployments/{app.live.deploymentId}/redeploy", { app }), "/deployments/42/redeploy");
  assert.throws(() => renderPath("/deployments/{app.latest.deploymentId}", { app }), /no value for app\.latest\.deploymentId/);
});

test("쿼리 — 값 없는 항목은 뺀다", () => {
  assert.equal(renderQuery({ step: "{step}", tail: "{tail}" }, { step: "build" }), "?step=build");
  assert.equal(renderQuery({ limit: "100" }, {}), "?limit=100");
  assert.equal(renderQuery({ tail: "{tail}" }, {}), "");
});

test("본문 — $값은 타입 그대로, 없는 값은 빼고, null 은 남긴다, 키도 템플릿", () => {
  assert.deepEqual(renderBody({ name: "$name", subdomain: "$subdomain" }, { name: "shop" }), { name: "shop" });
  assert.deepEqual(renderBody({ targetEnvironmentId: "{to}" }, {}), {});
  assert.deepEqual(renderBody({ vars: { "{key}": "$value" } }, { key: "API_URL", value: "https://x" }), { vars: { API_URL: "https://x" } });
  assert.deepEqual(renderBody({ vars: { "{key}": null } }, { key: "OLD" }), { vars: { OLD: null } });
  assert.deepEqual(renderBody({ project_id: "{app}", source: "$source" }, { app, source: { buffer: Buffer.from("z"), filename: "a.zip" } }).project_id, "7");
});

test("crc32 — 알려진 값", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip — 폴더를 묶고 node_modules · .git 은 뺀다, 내용이 그대로 풀린다", () => {
  const root = mkdtempSync(join(tmpdir(), "camellia-cli-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), '{"name":"t"}');
  writeFileSync(join(root, "src", "index.js"), "console.log('한글')\n".repeat(50));
  writeFileSync(join(root, "node_modules", "x", "big.js"), "x");
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  const { buffer, fileCount } = zipDirectory(root);
  assert.equal(fileCount, 2);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);

  // 중앙 디렉터리를 따라가며 각 파일을 풀어 본다
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  let cursor = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const local = buffer.readUInt32LE(cursor + 42);
    const packedSize = buffer.readUInt32LE(cursor + 20);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26);
    const data = inflateRawSync(buffer.subarray(dataStart, dataStart + packedSize));
    assert.equal(crc32(data), buffer.readUInt32LE(cursor + 16));
    names.push(name);
    cursor += 46 + nameLength;
  }
  assert.deepEqual(names, ["package.json", "src/index.js"]);
});

test("출력 — 한글은 두 칸, 메시지는 응답 필드로 채운다", () => {
  assert.equal(displayWidth("앱abc"), 5);
  assert.equal(fillMessage("배포 {deploymentId} · {missing}", { deploymentId: "9" }), "배포 9 · -");
});
