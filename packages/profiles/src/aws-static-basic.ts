import type { Profile } from "./types.js";

/**
 * 정적 사이트 프로필 (#273) — 서버 없이 S3 웹사이트 호스팅 + Cloudflare 프록시.
 * 빌드는 다른 프로필과 같이 컨테이너 이미지(nginx + 정적 파일) 하나를 만들고,
 * 배포 때 그 이미지에서 파일을 꺼내 버킷에 동기화한다 (같은 digest).
 * size_map 은 컨테이너를 띄우지 않아 의미가 없지만 공통 plan 형식을 맞추려고 둔다.
 */
export const awsStaticBasic: Profile = {
  id: "aws-static-basic",
  cloud: "aws",
  description: "AWS S3 정적 웹사이트 호스팅 + Cloudflare 프록시 (서버 없음)",
  version: "0.1.0",
  capabilities: {
    service_types: ["static"],
    resource_types: [],
    sizes: ["small", "medium", "large"],
    supports_public_expose: true,
    supports_internal_expose: false,
    max_services: 1,
  },
  runtime: {
    type: "s3-website",
    replicas: 1,
    size_map: {
      small: { vcpu: 0.25, memory_mib: 512 },
      medium: { vcpu: 0.25, memory_mib: 512 },
      large: { vcpu: 0.25, memory_mib: 512 },
    },
  },
  ingress: {
    type: "cloudflare-proxy",
    https: true,
  },
  default_region: "ap-northeast-2",
  terraform_module_ref: "infra/terraform/profiles/aws-static-basic",
};
