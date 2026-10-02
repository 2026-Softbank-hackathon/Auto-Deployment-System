import { describe, it, expect } from "vitest";
import {
  ProfileSchema,
  awsStaticBasic,
  getProfile,
  resolveProfile,
  resolveProfileAfterAnalysis,
} from "../src/index.js";

const httpIr = { services: { api: { type: "http" } } };
const staticIr = { services: { web: { type: "static" } } };

describe("aws-static-basic 프로필 (#273)", () => {
  it("스키마를 통과하고 카탈로그에 있다", () => {
    expect(ProfileSchema.safeParse(awsStaticBasic).success).toBe(true);
    expect(getProfile("aws-static-basic")).toBe(awsStaticBasic);
    expect(awsStaticBasic.capabilities.service_types).toEqual(["static"]);
    expect(awsStaticBasic.terraform_module_ref).toBe("infra/terraform/profiles/aws-static-basic");
  });

  it("온프레미스 프로필은 정적 사이트도 컨테이너로 받는다", () => {
    expect(getProfile("onprem-docker-basic")?.capabilities.service_types).toContain("static");
  });
});

describe("resolveProfile — 정적 사이트", () => {
  it("AWS + 정적 사이트 → aws-static-basic, 온프레미스 + 정적 사이트 → onprem-docker-basic", () => {
    expect(resolveProfile("aws", staticIr)).toBe("aws-static-basic");
    expect(resolveProfile("onprem", staticIr)).toBe("onprem-docker-basic");
  });

  it("서버리스를 골라도 정적 사이트는 S3 (서버 없는 쪽이 더 단순)", () => {
    expect(resolveProfile("aws", staticIr, { mode: "serverless" })).toBe("aws-static-basic");
  });

  it("http · 서비스가 여러 개 · 모양이 다른 값은 정적 사이트가 아님", () => {
    expect(resolveProfile("aws", httpIr)).toBe("aws-ecs-basic");
    expect(
      resolveProfile("aws", { services: { web: { type: "static" }, api: { type: "http" } } }),
    ).toBe("aws-ecs-basic");
    expect(resolveProfile("aws", "not-an-ir")).toBe("aws-ecs-basic");
  });
});

describe("resolveProfileAfterAnalysis — 분석 뒤 프로필 다시 고르기", () => {
  it("배포 생성 때 고른 프로필의 연결 종류 · 형태로 IR 에 맞게 다시 고른다", () => {
    expect(resolveProfileAfterAnalysis("aws-ecs-basic", staticIr)).toBe("aws-static-basic");
    expect(resolveProfileAfterAnalysis("aws-static-basic", httpIr)).toBe("aws-ecs-basic");
    expect(resolveProfileAfterAnalysis("aws-static-basic", staticIr)).toBe("aws-static-basic");
    expect(resolveProfileAfterAnalysis("onprem-docker-basic", staticIr)).toBe("onprem-docker-basic");
  });

  it("서버리스로 시작한 배포는 서버리스 형태를 유지한다", () => {
    expect(resolveProfileAfterAnalysis("aws-lambda-basic", httpIr)).toBe("aws-lambda-basic");
    expect(resolveProfileAfterAnalysis("aws-lambda-basic", staticIr)).toBe("aws-static-basic");
    expect(
      resolveProfileAfterAnalysis("aws-lambda-basic", { ...httpIr, resources: { db: { type: "postgres" } } }),
    ).toBe("aws-ecs-basic");
  });

  it("모르는 프로필은 그대로 둔다", () => {
    expect(resolveProfileAfterAnalysis("custom-profile", staticIr)).toBe("custom-profile");
  });
});
