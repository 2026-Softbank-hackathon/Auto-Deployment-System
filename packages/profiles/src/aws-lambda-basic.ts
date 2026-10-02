import type { Profile } from "./types.js";

/**
 * 서버리스 배포 형태 (사용자가 고급 설정에서 고를 때만).
 * 빌드 이미지에 들어 있는 Lambda Web Adapter 덕분에 ECS 와 같은 이미지 digest 를 Lambda 로 실행한다.
 * 공개 origin 은 aws-ecs-basic 과 같은 ALB(HTTP) — Cloudflare 가 서비스 주소를 Host 로 보내도 받는다.
 */
export const awsLambdaBasic: Profile = {
  id: "aws-lambda-basic",
  cloud: "aws",
  description: "AWS Lambda(같은 컨테이너 이미지 + Lambda Web Adapter) + ALB 서버리스 프로필",
  version: "0.1.0",
  capabilities: {
    service_types: ["http"],
    resource_types: [],
    sizes: ["small", "medium", "large"],
    supports_public_expose: true,
    supports_internal_expose: false,
    max_services: 1,
  },
  runtime: {
    type: "lambda",
    replicas: 1,
    // Lambda 는 메모리에 비례해 CPU 를 준다 (1,769MB = 1 vCPU). vcpu 는 그 비율로 적은 참고값
    size_map: {
      small: { vcpu: 0.29, memory_mib: 512 },
      medium: { vcpu: 0.58, memory_mib: 1024 },
      large: { vcpu: 1.16, memory_mib: 2048 },
    },
  },
  ingress: {
    type: "alb",
    https: true,
  },
  default_region: "ap-northeast-2",
  terraform_module_ref: "infra/terraform/profiles/aws-lambda-basic",
};
