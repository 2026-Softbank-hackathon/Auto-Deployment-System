import { describe, expect, it } from "vitest";
import { IrSchema } from "@camellia/ir-schema";
import { AdapterError, createDeploymentPlan } from "../src/index.js";
import { createSimpleHttpIr } from "./fixtures/simple-http-ir.js";

describe("aws-ecs-basic Adapter", () => {
  it("maps a simple HTTP IR to an ECS Fargate deployment plan", () => {
    const plan = createDeploymentPlan(
      createSimpleHttpIr("aws-ecs-basic"),
      "aws-ecs-basic",
    );

    expect(plan.target).toBe("aws");
    if (plan.target !== "aws") throw new Error("expected AWS plan");

    expect(plan.profile.id).toBe("aws-ecs-basic");
    expect(plan.runtime).toEqual({
      type: "ecs-fargate",
      region: "ap-northeast-2",
      taskCpu: 256,
      taskMemoryMiB: 512,
      desiredCount: 1,
    });
    expect(plan.service.containerPort).toBe(3000);
    expect(plan.health).toEqual({
      path: "/health",
      expectedStatus: 200,
      timeoutSeconds: 3,
    });
    expect(plan.ingress).toMatchObject({
      enabled: true,
      exposure: "public",
      type: "alb",
      tls: true,
    });
    expect(plan.provisioning.variables).toMatchObject({
      app_name: "demo-app",
      container_port: 3000,
      task_cpu: 256,
      task_memory: 512,
      health_check_path: "/health",
    });
  });

  it.each([
    ["small", 256, 512],
    ["medium", 512, 1024],
    ["large", 1024, 2048],
  ] as const)(
    "maps %s to valid Fargate CPU and memory values",
    (size, taskCpu, taskMemoryMiB) => {
      const plan = createDeploymentPlan(
        createSimpleHttpIr("aws-ecs-basic", size),
        "aws-ecs-basic",
      );

      expect(plan.target).toBe("aws");
      if (plan.target !== "aws" || plan.runtime.type !== "ecs-fargate") {
        throw new Error("expected AWS ECS plan");
      }
      expect(plan.runtime.taskCpu).toBe(taskCpu);
      expect(plan.runtime.taskMemoryMiB).toBe(taskMemoryMiB);
    },
  );

  it("rejects an unknown profile", () => {
    expect(() =>
      createDeploymentPlan(
        createSimpleHttpIr("aws-ecs-basic"),
        "does-not-exist",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({
        code: "PROFILE_NOT_FOUND",
      }),
    );
  });

  it("rejects an IR and target profile mismatch", () => {
    expect(() =>
      createDeploymentPlan(
        createSimpleHttpIr("aws-ecs-basic"),
        "onprem-docker-basic",
      ),
    ).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({
        code: "PROFILE_MISMATCH",
      }),
    );
  });

  describe("PostgreSQL 추가 모듈 (#278)", () => {
    function irWith(resources: Record<string, unknown>, env = ["NODE_ENV"]) {
      const base = createSimpleHttpIr("aws-ecs-basic");
      return IrSchema.parse({
        ...base,
        services: { web: { ...base.services["web"], env } },
        resources,
      });
    }

    it("enables the RDS module without a database by default", () => {
      const plan = createDeploymentPlan(createSimpleHttpIr("aws-ecs-basic"), "aws-ecs-basic");
      if (plan.target !== "aws") throw new Error("expected AWS plan");

      expect(plan.provisioning.variables).toMatchObject({ database_enabled: false });
    });

    it("maps a postgres resource to the module variables and injects its connection env", () => {
      const plan = createDeploymentPlan(
        irWith(
          { db: { type: "postgres", connection_env: "DATABASE_URL", local_fallback: "sqlite" } },
          ["NODE_ENV", "DATABASE_URL"],
        ),
        "aws-ecs-basic",
      );
      if (plan.target !== "aws") throw new Error("expected AWS plan");

      expect(plan.provisioning.variables).toMatchObject({
        database_enabled: true,
        database_env_name: "DATABASE_URL",
      });
      expect(plan.service.environmentNames).toEqual(["NODE_ENV"]);
    });

    it("defaults the connection env to DATABASE_URL for an app that already uses PostgreSQL", () => {
      const plan = createDeploymentPlan(
        irWith({ db: { type: "postgres" } }, ["DATABASE_URL", "PORT"]),
        "aws-ecs-basic",
      );
      if (plan.target !== "aws") throw new Error("expected AWS plan");

      expect(plan.provisioning.variables).toMatchObject({
        database_enabled: true,
        database_env_name: "DATABASE_URL",
      });
      expect(plan.service.environmentNames).toEqual(["PORT"]);
    });

    it("rejects more than one postgres resource", () => {
      expect(() =>
        createDeploymentPlan(
          irWith({ db: { type: "postgres" }, analytics: { type: "postgres", connection_env: "ANALYTICS_URL" } }),
          "aws-ecs-basic",
        ),
      ).toThrowError(
        expect.objectContaining<Partial<AdapterError>>({ code: "P0_RESOURCES_UNSUPPORTED" }),
      );
    });
  });
});
