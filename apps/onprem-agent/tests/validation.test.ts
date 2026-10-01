import { describe, expect, it } from "vitest";
import {
  parseOnpremAgentJob,
  validateEcrCredential,
} from "../src/validation.js";
import { createJob } from "./fixtures.js";

describe("On-Prem Agent 입력 검증", () => {
  it("합의된 job과 Plan을 허용한다", () => {
    expect(parseOnpremAgentJob(createJob())).toEqual(createJob());
  });

  it.each([
    ["잘못된 digest", { image: { ...createJob().image, digest: "latest" } }],
    ["지원하지 않는 platform", { image: { ...createJob().image, platform: "linux/arm64" } }],
    ["잘못된 Plan target", { plan: { ...createJob().plan, target: "aws" } }],
    ["잘못된 health path", { plan: { ...createJob().plan, health: { ...createJob().plan.health, path: "health" } } }],
    [
      "데모 범위 밖 시크릿",
      {
        plan: {
          ...createJob().plan,
          service: { ...createJob().plan.service, secretNames: ["API_TOKEN"] },
        },
      },
    ],
  ])("%s를 invalid_job으로 거부한다", (_label, overrides) => {
    expect(() => parseOnpremAgentJob({ ...createJob(), ...overrides })).toThrowError(
      expect.objectContaining({ code: "invalid_job" }),
    );
  });

  it("만료된 ECR credential을 거부한다", () => {
    expect(() =>
      validateEcrCredential(
        createJob(),
        {
          registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
          username: "AWS",
          password: "secret",
          expiresAt: "2026-09-30T00:00:00.000Z",
        },
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "ecr_auth_failed" }));
  });

  it("필드가 누락된 ECR 응답을 안전하게 거부한다", () => {
    expect(() =>
      validateEcrCredential(
        createJob(),
        { registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com" },
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "ecr_auth_failed" }));
  });

  it.each([
    "attacker.example.com",
    "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com.evil.test",
  ])("Registry 불일치 또는 잘못된 ECR hostname %s를 거부한다", (registry) => {
    expect(() =>
      validateEcrCredential(
        createJob(),
        {
          registry,
          username: "AWS",
          password: "secret",
          expiresAt: "2026-10-02T00:00:00.000Z",
        },
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toThrowError(expect.objectContaining({ code: "ecr_auth_failed" }));
  });
});
