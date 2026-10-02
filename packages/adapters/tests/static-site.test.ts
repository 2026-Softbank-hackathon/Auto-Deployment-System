import { describe, expect, it } from "vitest";
import { IrSchema } from "@camellia/ir-schema";
import { AdapterError, createDeploymentPlan, getRegisteredProfileIds } from "../src/index.js";
import { createSimpleHttpIr } from "./fixtures/simple-http-ir.js";

function createStaticIr(
  profile: string,
  site: { build_command?: string; output_dir?: string; spa_fallback?: boolean } = {
    build_command: "npm run build",
    output_dir: "dist",
  },
  port?: number,
) {
  return IrSchema.parse({
    metadata: { name: "landing", version: "2.0.0" },
    services: {
      web: {
        type: "static",
        ...(port !== undefined ? { port } : {}),
        health: { path: "/" },
        static: site,
      },
    },
    deploy: { profile },
  });
}

describe("정적 사이트 Adapter (#273)", () => {
  it("aws-static-basic: S3 웹사이트 Terraform plan + 정적 이미지 빌드 plan", () => {
    const plan = createDeploymentPlan(createStaticIr("aws-static-basic", undefined, 8080), "aws-static-basic");

    expect(plan.target).toBe("aws");
    expect(plan.runtime).toEqual({ type: "s3-website", region: "ap-northeast-2" });
    expect(plan.build).toEqual({
      context: ".",
      staticSite: { buildCommand: "npm run build", outputDir: "dist", spaFallback: true, listenPort: 8080 },
    });
    expect(plan.health).toEqual({ path: "/", expectedStatus: 200, timeoutSeconds: 3 });
    expect(plan.ingress).toMatchObject({ enabled: true, exposure: "public", type: "cloudflare-proxy" });
    expect(plan.provisioning).toEqual({
      engine: "terraform",
      moduleRef: "infra/terraform/profiles/aws-static-basic",
      variables: { app_name: "landing", region: "ap-northeast-2", spa_fallback: true },
    });
  });

  it("onprem-docker-basic: 같은 정적 이미지를 http 컨테이너로 실행 (Agent 변경 없음)", () => {
    const plan = createDeploymentPlan(
      createStaticIr("onprem-docker-basic", { output_dir: ".", spa_fallback: false }),
      "onprem-docker-basic",
    );

    expect(plan.target).toBe("onprem");
    // Agent 는 http 서비스만 받는다 — 정적 사이트 이미지는 nginx 가 HTTP 로 서빙한다
    expect(plan.service.type).toBe("http");
    expect(plan.service.containerPort).toBe(8080);
    expect(plan.service.command).toBeUndefined();
    expect(plan.service.environmentNames).toEqual([]);
    expect(plan.build).toEqual({
      context: ".",
      staticSite: { outputDir: ".", spaFallback: false, listenPort: 8080 },
    });
  });

  it("aws-static-basic 은 http 서비스를 받지 않는다", () => {
    expect(() =>
      createDeploymentPlan(
        { ...createSimpleHttpIr("aws-ecs-basic"), deploy: { profile: "aws-static-basic" } },
        "aws-static-basic",
      ),
    ).toThrow(AdapterError);
  });

  it("aws-ecs-basic 은 정적 사이트를 받지 않는다 (프로필 자동 선택이 aws-static-basic 으로 보냄)", () => {
    expect(() => createDeploymentPlan(createStaticIr("aws-ecs-basic"), "aws-ecs-basic")).toThrow(
      AdapterError,
    );
  });

  it("정적 사이트 Adapter 를 등록한다", () => {
    expect(getRegisteredProfileIds()).toContain("aws-static-basic");
  });
});
