import { awsEcsBasic } from "./aws-ecs-basic.js";
import { awsLambdaBasic } from "./aws-lambda-basic.js";
import { awsStaticBasic } from "./aws-static-basic.js";
import { onpremDockerBasic } from "./onprem-docker-basic.js";

/**
 * 배포 형태. 기본은 컨테이너이고, 서버리스는 사용자가 고급 설정에서 고를 때만 (9/30 합의:
 * 프로필은 시스템이 자동으로 고르고 사용자는 AWS/온프레미스만 고른다).
 */
export const DEPLOY_MODES = ["container", "serverless"] as const;
export type DeployMode = (typeof DEPLOY_MODES)[number];

export type ResolveProfileOptions = {
  mode?: DeployMode;
};

/**
 * 연결 종류(vendor) · IR · 배포 형태로 프로필을 고른다.
 * - aws + 정적 사이트(서비스가 static 하나) → aws-static-basic (형태와 관계없이 서버 없는 S3 웹사이트, #273)
 * - aws + serverless + Lambda 로 띄울 수 있는 앱(공개 HTTP 서비스 하나, 관리형 리소스 없음) → aws-lambda-basic
 * - 그 밖의 aws → aws-ecs-basic (서버리스로 못 띄우는 앱은 컨테이너로 되돌린다)
 * - onprem → onprem-docker-basic (형태와 관계없이 컨테이너 — 정적 사이트도 nginx 이미지로)
 * IR 이 없으면(분석 전) 요청한 형태를 그대로 따른다.
 */
export function resolveProfile(
  vendor: "aws" | "onprem",
  ir?: unknown,
  options: ResolveProfileOptions = {},
): string {
  if (vendor === "onprem") return onpremDockerBasic.id;
  if (isStaticSiteIr(ir)) return awsStaticBasic.id;
  if (options.mode === "serverless" && (ir === undefined || runsOnLambda(ir))) {
    return awsLambdaBasic.id;
  }
  return awsEcsBasic.id;
}

/** 시스템이 고르는 프로필 → 그 프로필을 고를 때의 연결 종류 · 형태 */
const AUTO_SELECTED: Record<string, { vendor: "aws" | "onprem"; mode: DeployMode }> = {
  [awsEcsBasic.id]: { vendor: "aws", mode: "container" },
  [awsStaticBasic.id]: { vendor: "aws", mode: "container" },
  [awsLambdaBasic.id]: { vendor: "aws", mode: "serverless" },
  [onpremDockerBasic.id]: { vendor: "onprem", mode: "container" },
};

/**
 * 분석이 끝나 IR 을 알게 됐을 때 배포의 프로필을 다시 고른다 (#273).
 * 배포를 만들 때 고른 프로필에서 연결 종류 · 형태를 읽어 resolveProfile 을 다시 부른다
 * (예: aws-ecs-basic + 정적 사이트 IR → aws-static-basic, aws-lambda-basic + Lambda 로 못 띄우는 IR → aws-ecs-basic).
 * 모르는 프로필은 그대로 둔다.
 */
export function resolveProfileAfterAnalysis(currentProfileId: string, ir: unknown): string {
  const selected = AUTO_SELECTED[currentProfileId];
  if (!selected) return currentProfileId;
  return resolveProfile(selected.vendor, ir, { mode: selected.mode });
}

/** 서비스가 정확히 하나이고 type 이 static 인 IR */
export function isStaticSiteIr(ir: unknown): boolean {
  if (!ir || typeof ir !== "object") return false;
  const services = (ir as { services?: unknown }).services;
  if (!services || typeof services !== "object") return false;
  const list = Object.values(services);
  return list.length === 1 && (list[0] as { type?: unknown } | undefined)?.type === "static";
}

function runsOnLambda(ir: unknown): boolean {
  if (!ir || typeof ir !== "object") return false;
  const { services, resources } = ir as { services?: unknown; resources?: unknown };
  if (resources && typeof resources === "object" && Object.keys(resources).length > 0) {
    return false;
  }
  if (!services || typeof services !== "object") return false;
  const list = Object.values(services);
  if (list.length !== 1) return false;
  const service = list[0] as { type?: unknown; expose?: unknown };
  return service.type === "http" && (service.expose === undefined || service.expose === "public");
}
