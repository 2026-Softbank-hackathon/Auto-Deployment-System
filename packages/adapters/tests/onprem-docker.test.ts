import { describe, expect, it } from "vitest";
import { createDeploymentPlan, getRegisteredProfileIds } from "../src/index.js";
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

  it("registers both P0 profile adapters", () => {
    expect(getRegisteredProfileIds().sort()).toEqual([
      "aws-ecs-basic",
      "onprem-docker-basic",
    ]);
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
