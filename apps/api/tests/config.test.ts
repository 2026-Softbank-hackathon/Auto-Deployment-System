import { describe, expect, it } from "vitest";
import { decodeSecretMasterKey } from "../src/config.js";

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
