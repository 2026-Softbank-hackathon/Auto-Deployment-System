import { describe, expect, it } from "vitest";
import { IrSchema } from "@camellia/ir-schema";
import { AdapterError, createDeploymentPlan, getRegisteredProfileIds } from "../src/index.js";
import { createSimpleHttpIr } from "./fixtures/simple-http-ir.js";

describe("onprem-docker-basic Adapter", () => {
  it("maps a simple HTTP IR to a Docker Compose deployment plan", () => {
    const plan = createDeploymentPlan(
      createSimpleHttpIr("onprem-docker-basic"),
      "onprem-docker-basic",
    );

    expect(plan.target).toBe("onprem");
    if (plan.target !== "onprem") throw new Error("expected On-Prem plan");

    expect(plan.profile.id).toBe("onprem-docker-basic");
    expect(plan.runtime).toEqual({
      type: "docker-compose",
      cpus: 0.25,
      memoryMiB: 512,
      replicas: 1,
    });
    expect(plan.service.containerPort).toBe(3000);
    expect(plan.ingress).toMatchObject({
      enabled: true,
      exposure: "public",
      type: "cloudflare-tunnel",
      tls: true,
    });
    expect(plan.provisioning).toEqual({
      engine: "docker-compose",
      projectName: "demo-app",
    });
  });

  it("registers the profile adapters", () => {
    expect(getRegisteredProfileIds().sort()).toEqual([
      "aws-ecs-basic",
      "aws-lambda-basic",
      "onprem-docker-basic",
    ]);
  });

  it("keeps the SQLite fallback instead of a managed database (environment difference)", () => {
    const base = createSimpleHttpIr("onprem-docker-basic");
    const ir = IrSchema.parse({
      ...base,
      services: { web: { ...base.services["web"], env: ["NODE_ENV", "DATABASE_URL"] } },
      resources: {
        db: { type: "postgres", connection_env: "DATABASE_URL", local_fallback: "sqlite" },
      },
    });

    const plan = createDeploymentPlan(ir, "onprem-docker-basic");

    // DATABASE_URL 을 주지 않아야 앱이 SQLite 로 동작한다
    expect(plan.service.environmentNames).toEqual(["NODE_ENV"]);
    expect(plan.resources).toEqual([
      { name: "db", type: "postgres", connectionEnv: "DATABASE_URL", localFallback: "sqlite" },
    ]);
  });

  it("still rejects a database the app cannot run without", () => {
    const ir = IrSchema.parse({
      ...createSimpleHttpIr("onprem-docker-basic"),
      resources: { db: { type: "postgres" } },
    });

    expect(() => createDeploymentPlan(ir, "onprem-docker-basic")).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({ code: "P0_RESOURCES_UNSUPPORTED" }),
    );
  });

  it("maps the supported medium size to Docker limits", () => {
    const plan = createDeploymentPlan(
      createSimpleHttpIr("onprem-docker-basic", "medium"),
      "onprem-docker-basic",
    );

    expect(plan.target).toBe("onprem");
    if (plan.target !== "onprem") throw new Error("expected On-Prem plan");
    expect(plan.runtime.cpus).toBe(0.5);
    expect(plan.runtime.memoryMiB).toBe(1024);
  });
});
