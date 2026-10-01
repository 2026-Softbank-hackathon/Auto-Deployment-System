variable "region" {
  description = "플랫폼 EC2 를 띄울 AWS 리전"
  type        = string
  default     = "ap-northeast-2"
}

variable "name_prefix" {
  description = "AWS 리소스 이름 접두어"
  type        = string
  default     = "camellia-platform"
}

variable "instance_type" {
  description = "EC2 인스턴스 타입 (x86_64 — 사용자 이미지가 linux/amd64)"
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gb" {
  description = "루트 EBS(gp3) 크기. Docker 이미지 · BuildKit 캐시 · Postgres 데이터가 모두 여기에 쌓인다"
  type        = number
  default     = 40

  validation {
    condition     = var.root_volume_size_gb >= 20
    error_message = "root_volume_size_gb 는 20 이상이어야 한다."
  }
}

variable "vpc_cidr" {
  description = "플랫폼 전용 VPC CIDR (퍼블릭 서브넷 1개, NAT 없음)"
  type        = string
  default     = "10.80.0.0/16"
}

variable "git_repository_url" {
  description = "EC2 가 clone 할 리포 (public)"
  type        = string
  default     = "https://github.com/2026-Softbank-hackathon/Auto-Deployment-System.git"
}

variable "git_ref" {
  description = "최초 부팅 때 배포할 브랜치 · 태그 · 커밋. 이후 갱신은 scripts/deploy.sh <ref> (user_data 변경은 무시됨)"
  type        = string
  default     = "main"
}

variable "ssm_parameter_prefix" {
  description = "플랫폼 env 를 담는 SSM Parameter Store 경로. 이 경로 아래 파라미터 이름이 그대로 env 이름이 된다"
  type        = string
  default     = "/camellia/platform/env"

  validation {
    condition     = can(regex("^/[A-Za-z0-9_./-]*[A-Za-z0-9_-]$", var.ssm_parameter_prefix))
    error_message = "ssm_parameter_prefix 는 / 로 시작하고 / 로 끝나지 않아야 한다."
  }
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (Tunnel 소유 계정)"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "platform_domain 의 Cloudflare zone ID"
  type        = string
}

variable "platform_domain" {
  description = "Cloudflare 가 관리하는 팀 도메인"
  type        = string
  default     = "camellia-deploy.app"
}

variable "console_subdomain" {
  description = "플랫폼 콘솔 서브도메인. 사용자 앱이 쓰는 apps.<도메인> 과 겹치면 안 된다"
  type        = string
  default     = "console"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.console_subdomain)) && var.console_subdomain != "apps"
    error_message = "console_subdomain 은 한 단계 DNS 라벨이어야 하고 'apps'(사용자 앱 영역)는 쓸 수 없다."
  }
}
