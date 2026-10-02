import { IrSchema } from "@camellia/ir-schema";
import { describe, expect, it } from "vitest";
import { AdapterError, createDeploymentPlan, getRegisteredProfileIds } from "../src/index.js";
import { createSimpleHttpIr } from "./fixtures/simple-http-ir.js";

describe("aws-lambda-basic Adapter", () => {
  it("maps a simple HTTP IR to a Lambda deployment plan with the same build", () => {
    const plan = createDeploymentPlan(
      createSimpleHttpIr("aws-lambda-basic"),
      "aws-lambda-basic",
    );
    const ecsPlan = createDeploymentPlan(
      createSimpleHttpIr("aws-ecs-basic"),
      "aws-ecs-basic",
    );

    expect(getRegisteredProfileIds()).toContain("aws-lambda-basic");
    expect(plan.target).toBe("aws");
    if (plan.target !== "aws" || plan.runtime.type !== "lambda") {
      throw new Error("expected AWS Lambda plan");
    }
    expect(plan.profile.id).toBe("aws-lambda-basic");
    expect(plan.runtime).toEqual({
      type: "lambda",
      region: "ap-northeast-2",
      memoryMiB: 512,
      timeoutSeconds: 30,
    });
    // 빌드 · 서비스 · 헬스체크는 컨테이너 배포와 같다 (같은 이미지)
    expect(plan.build).toEqual(ecsPlan.build);
    expect(plan.health).toEqual(ecsPlan.health);
    expect(plan.ingress).toMatchObject({ enabled: true, exposure: "public", type: "alb", tls: true });
    expect(plan.provisioning).toEqual({
      engine: "terraform",
      moduleRef: "infra/terraform/profiles/aws-lambda-basic",
      variables: {
        app_name: "demo-app",
        region: "ap-northeast-2",
        container_port: 3000,
        memory_size: 512,
        timeout: 30,
        health_check_path: "/health",
        public_ingress: true,
      },
    });
  });

  it.each([
    ["small", 512],
    ["medium", 1024],
    ["large", 2048],
  ] as const)("maps %s to %i MiB Lambda memory", (size, memoryMiB) => {
    const plan = createDeploymentPlan(
      createSimpleHttpIr("aws-lambda-basic", size),
      "aws-lambda-basic",
    );
    if (plan.target !== "aws" || plan.runtime.type !== "lambda") {
      throw new Error("expected AWS Lambda plan");
    }
    expect(plan.runtime.memoryMiB).toBe(memoryMiB);
    expect(plan.provisioning.variables["memory_size"]).toBe(memoryMiB);
  });

  it("rejects an internal-only service because Lambda is exposed only through the public ALB", () => {
    const ir = createSimpleHttpIr("aws-lambda-basic");
    const internal = IrSchema.parse({
      ...ir,
      services: { web: { ...ir.services["web"], expose: "internal" } },
    });
    expect(() => createDeploymentPlan(internal, "aws-lambda-basic")).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({ code: "PROFILE_INCOMPATIBLE" }),
    );
  });
});
