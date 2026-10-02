/**
 * apps/worker/tests/log-messages.test.ts
 * 단계 로그 문구 키 (#147) — 워커 문구표와 웹 사전(apps/web/src/i18n/log-lines.ts)이 맞는지,
 * 워커 코드가 고정 한국어 문구를 키 없이 단계 로그에 쓰지 않는지 확인한다.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOG_MESSAGES,
  formatLogText,
  logMessage,
  renderLogText,
  type LogKey,
} from "../src/log-messages.js";
import { localizeLogLine, logLinesJa, logLinesKo, readLogTag } from "../../web/src/i18n/log-lines";

const HANGUL = /[가-힣]/;
const placeholders = (template: string) => new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));

describe("단계 로그 문구표", () => {
  const keys = Object.keys(LOG_MESSAGES) as LogKey[];

  it("웹 사전에 워커의 키가 모두 있고 한국어 문구가 같다", () => {
    expect(Object.keys(logLinesKo).sort()).toEqual([...keys].sort());
    expect(Object.keys(logLinesJa).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(logLinesKo[key], key).toBe(LOG_MESSAGES[key]);
  });

  it("일본어 문구는 한글이 없고, 한국어 문구에 없는 값을 쓰지 않는다", () => {
    for (const key of keys) {
      const ja = logLinesJa[key];
      expect(HANGUL.test(ja), `${key}: ${ja}`).toBe(false);
      const known = placeholders(LOG_MESSAGES[key]);
      for (const name of placeholders(ja)) expect(known.has(name), `${key}: {${name}}`).toBe(true);
    }
  });
});

describe("formatLogText", () => {
  it("키로 쓴 문구는 한국어 문구 뒤에 키 · 값을 붙인다", () => {
    const text = formatLogText(logMessage("build.failed", { code: "BUILD_FAILED" }));
    expect(text).toBe('빌드 실패: BUILD_FAILED #i18n{"k":"build.failed","p":{"code":"BUILD_FAILED"}}');
  });

  it("원문 문자열은 그대로 둔다 (도구 출력 · 오류 상세)", () => {
    expect(formatLogText("Error: exit status 1")).toBe("Error: exit status 1");
  });

  it("값의 줄바꿈은 공백으로 바꿔 한 줄을 지킨다", () => {
    const text = formatLogText(logMessage("analyze.failed", { error: "첫 줄\n  둘째 줄" }));
    expect(text.split("\n")).toHaveLength(1);
    expect(renderLogText(logMessage("analyze.failed", { error: "a\nb" }))).toBe("분석 실패: a b");
  });

  it("웹이 같은 줄을 일본어 · 한국어로 다시 그린다", () => {
    const line = `[2026-10-02T00:00:00.000Z] ${formatLogText(logMessage("ecs.taskRunning", { running: 1, desired: 2 }))}`;
    expect(readLogTag(line)).toEqual({ key: "ecs.taskRunning", params: { running: 1, desired: 2 } });
    expect(localizeLogLine(line, logLinesJa)).toBe("[2026-10-02T00:00:00.000Z] 新しいタスクが実行中 (1/2)");
    expect(localizeLogLine(line, logLinesKo)).toBe("[2026-10-02T00:00:00.000Z] 새 태스크 실행 (1/2)");
  });

  it("모르는 키 · 키 없는 줄은 원문 그대로 (키 표시만 뗌)", () => {
    expect(localizeLogLine('[t] 새 문구 #i18n{"k":"future.key"}', logLinesJa)).toBe("[t] 새 문구");
    expect(localizeLogLine("[t] terraform: exit 1", logLinesJa)).toBe("[t] terraform: exit 1");
  });
});

describe("워커 코드", () => {
  it("단계 로그에 고정 한국어 문구를 키 없이 쓰지 않는다", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const files = (await fs.readdir(root, { recursive: true }))
      .filter((file) => file.endsWith(".ts") && !file.endsWith("log-messages.ts"));
    // stepLog.line("…") · log?.("…") · input.log(`…`) · write("slot", "…") 처럼 문자열을 바로 넘기는 곳
    const call = /(?:\.line|\blog\??\.?|\bwrite)\(\s*(?:"[^"]*",\s*)?[`"'][^`"']*[가-힣]/g;
    const found: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(root, file), "utf8");
      for (const match of source.matchAll(call)) found.push(`${file}: ${match[0].replace(/\s+/g, " ")}`);
    }
    expect(found).toEqual([]);
  });
});
