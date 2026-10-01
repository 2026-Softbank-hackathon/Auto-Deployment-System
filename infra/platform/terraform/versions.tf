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

  # state 는 S3 backend(backend.tf). state 에 Tunnel token 이 들어가므로 암호화 · 접근 제한 bucket.
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
