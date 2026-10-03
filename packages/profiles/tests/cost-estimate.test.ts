import { describe, expect, it } from "vitest";
import {
  awsEcsBasic,
  awsLambdaBasic,
  awsStaticBasic,
  estimateMonthlyCost,
  onpremDockerBasic,
} from "../src/index.js";

const keys = (items: { key: string }[]) => items.map((item) => item.key);

describe("estimateMonthlyCost (#327)", () => {
  it("ECS small: Fargate 0.25 vCPU · 0.5 GB + ALB + 퍼블릭 IPv4 3개", () => {
    const estimate = estimateMonthlyCost({ profile: awsEcsBasic, size: "small", database: false });
    expect(keys(estimate.items)).toEqual(["fargate_compute", "load_balancer", "public_ipv4"]);
    // 0.25×0.04656×730 + 0.5×0.00511×730 = 8.50 + 1.87
    expect(estimate.items[0]!.monthlyUsd).toBe(10.36);
    expect(estimate.items[1]!.monthlyUsd).toBe(22.27);
    expect(estimate.items[2]!.monthlyUsd).toBe(10.95);
    expect(estimate.monthlyUsd).toBe(43.58);
    expect(estimate.region).toBe("ap-northeast-2");
  });

  it("ECS medium 은 small 보다 컴퓨팅이 두 배", () => {
    const small = estimateMonthlyCost({ profile: awsEcsBasic, size: "small", database: false });
    const medium = estimateMonthlyCost({ profile: awsEcsBasic, size: "medium", database: false });
    expect(medium.items[0]!.monthlyUsd).toBeCloseTo(small.items[0]!.monthlyUsd * 2, 1);
  });

  it("PostgreSQL 이 있으면 RDS 인스턴스 · 저장소 · 비밀번호 보관을 더한다", () => {
    const estimate = estimateMonthlyCost({ profile: awsEcsBasic, size: "small", database: true });
    expect(keys(estimate.items)).toEqual([
      "fargate_compute", "load_balancer", "public_ipv4", "rds_instance", "rds_storage", "rds_secret",
    ]);
    expect(estimate.monthlyUsd).toBe(65.58);
  });

  it("Lambda 는 실행 비용이 쓰는 만큼이고 ALB 가 대부분", () => {
    const estimate = estimateMonthlyCost({ profile: awsLambdaBasic, size: "small", database: false });
    expect(estimate.items.find((item) => item.key === "lambda_requests")?.usageBased).toBe(true);
    expect(estimate.monthlyUsd).toBe(29.57);
  });

  it("정적 사이트는 S3 저장 비용만", () => {
    const estimate = estimateMonthlyCost({ profile: awsStaticBasic, size: "small", database: false });
    expect(keys(estimate.items)).toEqual(["s3_storage"]);
    expect(estimate.monthlyUsd).toBeLessThan(1);
  });

  it("온프레미스는 클라우드 비용 0 · 리전 없음", () => {
    const estimate = estimateMonthlyCost({ profile: onpremDockerBasic, size: "small", database: true });
    expect(estimate.monthlyUsd).toBe(0);
    expect(estimate.region).toBeNull();
  });

  it("모르는 size 는 small 로 계산", () => {
    const unknown = estimateMonthlyCost({ profile: awsEcsBasic, size: "huge", database: false });
    const small = estimateMonthlyCost({ profile: awsEcsBasic, size: "small", database: false });
    expect(unknown.monthlyUsd).toBe(small.monthlyUsd);
  });
});
