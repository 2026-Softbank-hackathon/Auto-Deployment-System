terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # 기본은 로컬 state. 팀이 같이 apply 하려면 backend.tf.example → backend.tf 로 복사해
  # S3 backend(use_lockfile) 를 켠다. state 에 Tunnel token 이 들어가므로 암호화 bucket 필수.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "camellia"
      Component = "platform"
      ManagedBy = "terraform"
    }
  }
}

# 인증: 환경변수 CLOUDFLARE_API_TOKEN (Account: Cloudflare Tunnel Edit, Zone: DNS Edit)
provider "cloudflare" {}
