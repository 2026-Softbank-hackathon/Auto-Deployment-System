import { describe, expect, it } from "vitest";
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
      if (plan.target !== "aws") throw new Error("expected AWS plan");
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
});
