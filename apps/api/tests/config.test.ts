import { describe, expect, it } from "vitest";
import { assertProductionSecurity, decodeSecretMasterKey, loadConfig, type Config } from "../src/config.js";

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "development",
    PORT: 3000,
    HOST: "0.0.0.0",
    STORAGE_ROOT_DIR: "/tmp/camellia-storage",
    LOG_LEVEL: "info",
    ...overrides,
  };
}

describe("decodeSecretMasterKey", () => {
  it("base64 32바이트 키를 복호화용 Buffer로 변환한다", () => {
    const source = Buffer.alloc(32, 7);

    expect(decodeSecretMasterKey(source.toString("base64"), "production")).toEqual(
      source,
    );
  });

  it("production에서 키가 없으면 부팅을 거부한다", () => {
    expect(() => decodeSecretMasterKey(undefined, "production")).toThrow(
      "production에서는 SECRET_MASTER_KEY가 필요합니다.",
    );
  });

  it("development/test에서는 키가 없으면 기존 랜덤 fallback을 허용한다", () => {
    expect(decodeSecretMasterKey(undefined, "development")).toBeUndefined();
    expect(decodeSecretMasterKey(undefined, "test")).toBeUndefined();
  });

  it.each(["not-base64", Buffer.alloc(16).toString("base64")])(
    "잘못된 키 %s를 거부한다",
    (value) => {
      expect(() => decodeSecretMasterKey(value, "production")).toThrow(
        "SECRET_MASTER_KEY는 base64 인코딩된 32바이트여야 합니다.",
      );
    },
  );
});

describe("DEMO_PLATFORM_DOMAIN 파싱", () => {
  it("세팅 시 config 에 문자열로 포함된다", () => {
    const original = process.env["DEMO_PLATFORM_DOMAIN"];
    process.env["DEMO_PLATFORM_DOMAIN"] = "camellia.app";
    try {
      const config = loadConfig();
      expect(config.DEMO_PLATFORM_DOMAIN).toBe("camellia.app");
    } finally {
      if (original === undefined) {
        delete process.env["DEMO_PLATFORM_DOMAIN"];
      } else {
        process.env["DEMO_PLATFORM_DOMAIN"] = original;
      }
    }
  });

  it("미세팅 시 undefined", () => {
    const original = process.env["DEMO_PLATFORM_DOMAIN"];
    delete process.env["DEMO_PLATFORM_DOMAIN"];
    try {
      const config = loadConfig();
      expect(config.DEMO_PLATFORM_DOMAIN).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env["DEMO_PLATFORM_DOMAIN"] = original;
      }
    }
  });
});

describe("assertProductionSecurity", () => {
  const prodKey = Buffer.alloc(32, 1).toString("base64");

  it("production 에서 API_KEY·SECRET_MASTER_KEY 를 요구한다", () => {
    expect(() =>
      assertProductionSecurity(
        baseConfig({ NODE_ENV: "production", API_KEY: "k", SECRET_MASTER_KEY: prodKey }),
      ),
    ).not.toThrow();
    expect(() => assertProductionSecurity(baseConfig({ NODE_ENV: "production" }))).toThrow(
      /API_KEY/,
    );
    expect(() =>
      assertProductionSecurity(baseConfig({ NODE_ENV: "production", API_KEY: "k" })),
    ).toThrow(/SECRET_MASTER_KEY/);
  });

  it("development 에서는 no-op", () => {
    expect(() => assertProductionSecurity(baseConfig())).not.toThrow();
  });
});
