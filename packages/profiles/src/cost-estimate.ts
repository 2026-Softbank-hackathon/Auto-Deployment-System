import type { Profile } from "./types.js";

/**
 * 월 예상 인프라 비용 (#327). 프로필이 만드는 리소스를 서울 리전(ap-northeast-2) 온디맨드 단가로 계산한다.
 * 트래픽 · 데이터 전송 · 로그처럼 쓰는 만큼 나가는 비용은 빼고, 켜 두기만 해도 나가는 비용만 더한다.
 * 한 달 = 730시간.
 *
 * 단가 (USD, 2026-10 AWS 요금표 기준 · ap-northeast-2)
 * - Fargate Linux/x86: vCPU 시간당 0.04656 · GB 시간당 0.00511
 * - ALB: 시간당 0.0225 + LCU 시간당 0.008 (낮은 트래픽이라 LCU 1개로 잡음)
 * - 퍼블릭 IPv4: 주소 하나 시간당 0.005 (ECS 태스크 1 + ALB 서브넷 2)
 * - RDS PostgreSQL db.t4g.micro 단일 AZ: 시간당 0.026 · gp3 GB 월 0.131 · 마스터 비밀번호 Secrets Manager 월 0.40
 * - Lambda · S3: 요청 · 저장한 만큼만 나가 데모 규모에서는 1달러 미만
 */
export const MONTHLY_HOURS = 730;

const PRICE = {
  fargateVcpuHour: 0.04656,
  fargateGbHour: 0.00511,
  albHour: 0.0225,
  albLcuHour: 0.008,
  publicIpv4Hour: 0.005,
  rdsT4gMicroHour: 0.026,
  rdsGp3GbMonth: 0.131,
  secretMonth: 0.4,
} as const;

/** infra/terraform/profiles/aws-ecs-basic/database.tf 의 allocated_storage */
const RDS_STORAGE_GB = 20;
/** ALB 는 public 서브넷 2개에 걸쳐 주소를 하나씩 받는다 (network.tf) */
const ALB_PUBLIC_IPS = 2;

export type CostLineItemKey =
  | "fargate_compute"
  | "load_balancer"
  | "public_ipv4"
  | "rds_instance"
  | "rds_storage"
  | "rds_secret"
  | "lambda_requests"
  | "s3_storage"
  | "own_server";

export type CostLineItem = {
  key: CostLineItemKey;
  monthlyUsd: number;
  /** 쓰는 만큼 나가는 항목 — monthlyUsd 는 데모 규모의 대략값 */
  usageBased: boolean;
};

export type MonthlyCostEstimate = {
  currency: "USD";
  /** 단가를 잡은 리전. 온프레미스는 null */
  region: string | null;
  monthlyUsd: number;
  items: CostLineItem[];
};

export type CostEstimateInput = {
  profile: Profile;
  /** IR 서비스의 size (small · medium · large) */
  size: string;
  /** IR 에 PostgreSQL 리소스가 있어 RDS 를 만드는지 (aws-ecs-basic 만) */
  database: boolean;
};

const round = (value: number): number => Math.round(value * 100) / 100;
const hourly = (perHour: number): number => perHour * MONTHLY_HOURS;

function loadBalancerItems(): CostLineItem[] {
  return [
    { key: "load_balancer", monthlyUsd: round(hourly(PRICE.albHour + PRICE.albLcuHour)), usageBased: false },
  ];
}

export function estimateMonthlyCost({ profile, size, database }: CostEstimateInput): MonthlyCostEstimate {
  const region = profile.cloud === "onprem" ? null : (profile.default_region ?? "ap-northeast-2");
  const compute = profile.runtime.size_map[size as keyof typeof profile.runtime.size_map]
    ?? profile.runtime.size_map.small;
  const items: CostLineItem[] = [];

  switch (profile.runtime.type) {
    case "ecs-fargate": {
      const replicas = profile.runtime.replicas;
      const vcpu = compute?.vcpu ?? 0.25;
      const memoryGb = (compute?.memory_mib ?? 512) / 1024;
      items.push({
        key: "fargate_compute",
        monthlyUsd: round(hourly(vcpu * PRICE.fargateVcpuHour + memoryGb * PRICE.fargateGbHour) * replicas),
        usageBased: false,
      });
      items.push(...loadBalancerItems());
      items.push({
        key: "public_ipv4",
        monthlyUsd: round(hourly(PRICE.publicIpv4Hour) * (replicas + ALB_PUBLIC_IPS)),
        usageBased: false,
      });
      if (database) {
        items.push(
          { key: "rds_instance", monthlyUsd: round(hourly(PRICE.rdsT4gMicroHour)), usageBased: false },
          { key: "rds_storage", monthlyUsd: round(RDS_STORAGE_GB * PRICE.rdsGp3GbMonth), usageBased: false },
          { key: "rds_secret", monthlyUsd: PRICE.secretMonth, usageBased: false },
        );
      }
      break;
    }
    case "lambda":
      items.push({ key: "lambda_requests", monthlyUsd: 0, usageBased: true });
      items.push(...loadBalancerItems());
      items.push({ key: "public_ipv4", monthlyUsd: round(hourly(PRICE.publicIpv4Hour) * ALB_PUBLIC_IPS), usageBased: false });
      break;
    case "s3-website":
      items.push({ key: "s3_storage", monthlyUsd: 0.01, usageBased: true });
      break;
    case "docker-compose":
      items.push({ key: "own_server", monthlyUsd: 0, usageBased: false });
      break;
  }

  return {
    currency: "USD",
    region,
    monthlyUsd: round(items.reduce((sum, item) => sum + item.monthlyUsd, 0)),
    items,
  };
}
