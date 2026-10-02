import { describe, expect, it } from "vitest";
import {
  DEPLOY_MODES,
  PROFILES,
  ProfileSchema,
  awsLambdaBasic,
  getProfile,
  resolveProfile,
} from "../src/index.js";

const httpIr = {
  services: { web: { type: "http", port: 3000 } },
};

describe("aws-lambda-basic profile", () => {
  it("parses with the profile schema and is registered", () => {
    expect(ProfileSchema.safeParse(awsLambdaBasic).success).toBe(true);
    expect(getProfile("aws-lambda-basic")).toBe(awsLambdaBasic);
    expect(PROFILES["aws-lambda-basic"]).toBe(awsLambdaBasic);
  });

  it("runs one public HTTP service on Lambda behind the ALB origin", () => {
    expect(awsLambdaBasic.cloud).toBe("aws");
    expect(awsLambdaBasic.runtime.type).toBe("lambda");
    expect(awsLambdaBasic.ingress.type).toBe("alb");
    expect(awsLambdaBasic.capabilities.service_types).toEqual(["http"]);
    expect(awsLambdaBasic.capabilities.resource_types).toEqual([]);
    expect(awsLambdaBasic.capabilities.supports_internal_expose).toBe(false);
    expect(awsLambdaBasic.capabilities.max_services).toBe(1);
    expect(awsLambdaBasic.runtime.size_map.small?.memory_mib).toBe(512);
    expect(awsLambdaBasic.terraform_module_ref).toBe("infra/terraform/profiles/aws-lambda-basic");
  });
});

describe("resolveProfile", () => {
  it("keeps the container profile by default", () => {
    expect(DEPLOY_MODES).toEqual(["container", "serverless"]);
    expect(resolveProfile("aws")).toBe("aws-ecs-basic");
    expect(resolveProfile("aws", httpIr, { mode: "container" })).toBe("aws-ecs-basic");
    expect(resolveProfile("onprem")).toBe("onprem-docker-basic");
  });

  it("picks aws-lambda-basic for an AWS serverless deployment of an HTTP app", () => {
    expect(resolveProfile("aws", httpIr, { mode: "serverless" })).toBe("aws-lambda-basic");
    // 분석 전(IR 없음)에는 요청한 형태를 그대로 따른다
    expect(resolveProfile("aws", undefined, { mode: "serverless" })).toBe("aws-lambda-basic");
  });

  it("ignores the mode on-prem", () => {
    expect(resolveProfile("onprem", httpIr, { mode: "serverless" })).toBe("onprem-docker-basic");
  });

  it("falls back to the container profile when the app cannot run on Lambda", () => {
    const worker = { services: { job: { type: "worker" } } };
    const twoServices = { services: { web: { type: "http" }, api: { type: "http" } } };
    const withDatabase = { services: { web: { type: "http" } }, resources: { db: { type: "postgres" } } };
    for (const ir of [worker, twoServices, withDatabase]) {
      expect(resolveProfile("aws", ir, { mode: "serverless" })).toBe("aws-ecs-basic");
    }
  });
});
