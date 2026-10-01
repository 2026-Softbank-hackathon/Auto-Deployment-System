/**
 * paths.test.ts
 * 분석 결과에 들어가는 경로(detected_from · warning path · service path)는 OS 와 무관하게
 * 상대 경로 + "/" 구분이어야 한다. path.win32 / path.posix 를 주입해 어느 호스트에서든 같은 검사를 한다.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { relativePosix, toPosix } from "../src/paths.js";

describe("relativePosix", () => {
  it("win32: 역슬래시 서비스 디렉터리 + fast-glob 의 / 절대 경로 → 상대 경로", () => {
    expect(relativePosix("C:\\src\\app", "C:/src/app/.env.example", path.win32)).toBe(".env.example");
  });

  it("win32: 하위 디렉터리 파일은 / 로 이어 붙인다", () => {
    expect(relativePosix("C:\\src\\app", "C:/src/app/src/config.js", path.win32)).toBe("src/config.js");
    expect(relativePosix("C:\\src\\app", "C:\\src\\app\\services\\api", path.win32)).toBe("services/api");
  });

  it("posix: 기존 동작 그대로", () => {
    expect(relativePosix("/src/app", "/src/app/.env.example", path.posix)).toBe(".env.example");
    expect(relativePosix("/src/app", "/src/app/src/config.js", path.posix)).toBe("src/config.js");
  });
});

describe("toPosix", () => {
  it("win32 구분자를 / 로", () => {
    expect(toPosix("C:\\src\\app\\server.js", path.win32)).toBe("C:/src/app/server.js");
  });

  it("posix 에서는 역슬래시를 건드리지 않는다 (파일 이름 문자)", () => {
    expect(toPosix("/src/a\\b.js", path.posix)).toBe("/src/a\\b.js");
  });
});
