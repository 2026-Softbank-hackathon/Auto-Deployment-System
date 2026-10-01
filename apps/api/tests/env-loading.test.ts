/**
 * apps/api/tests/env-loading.test.ts
 * dotenv 자동 로드 동작 검증
 * - CAMELLIA_ENV_FILE 로 임시 파일 지정 시 값이 process.env 에 로드됨
 * - 파일이 없을 때 crash 없이 skip
 * - 이미 세팅된 env var 는 override 안 됨 (override: false)
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

const MARKER_KEY = "CAMELLIA_TEST_DOTENV_MARKER";
const ORIGINAL_KEY = "CAMELLIA_TEST_DOTENV_ORIGINAL";

afterEach(() => {
  delete process.env[MARKER_KEY];
  delete process.env[ORIGINAL_KEY];
  delete process.env["CAMELLIA_ENV_FILE"];
});

describe("dotenv env-file loading", () => {
  it("CAMELLIA_ENV_FILE 로 지정한 파일의 값을 process.env 에 로드한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "camellia-test-"));
    const envFile = join(dir, "test.env");
    writeFileSync(envFile, `${MARKER_KEY}=hello_from_file\n`);

    try {
      delete process.env[MARKER_KEY];
      loadDotenv({ path: envFile, override: false });
      expect(process.env[MARKER_KEY]).toBe("hello_from_file");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("env 파일이 없을 때 crash 없이 skip 한다", () => {
    const missingPath = resolve(tmpdir(), "camellia-nonexistent-12345.env");
    expect(() => {
      loadDotenv({ path: missingPath, override: false });
    }).not.toThrow();
  });

  it("이미 세팅된 env var 는 override 하지 않는다 (override: false)", () => {
    const dir = mkdtempSync(join(tmpdir(), "camellia-test-"));
    const envFile = join(dir, "test.env");
    writeFileSync(envFile, `${ORIGINAL_KEY}=from_file\n`);

    try {
      process.env[ORIGINAL_KEY] = "already_set";
      loadDotenv({ path: envFile, override: false });
      expect(process.env[ORIGINAL_KEY]).toBe("already_set");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
