# terraform test — 실제 AWS · Cloudflare 호출 없이 mock provider 로 plan 만 검증한다.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["ap-northeast-2a", "ap-northeast-2c"]
    }
  }
  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "ami-0123456789abcdef0"
    }
  }
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

mock_provider "cloudflare" {
  mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
    override_during = plan
    defaults = {
      id = "11111111-2222-3333-4444-555555555555"
    }
  }
  mock_data "cloudflare_zero_trust_tunnel_cloudflared_token" {
    defaults = {
      token = "mock-tunnel-token"
    }
  }
}

variables {
  cloudflare_account_id = "0123456789abcdef0123456789abcdef"
  cloudflare_zone_id    = "fedcba9876543210fedcba9876543210"
}

run "plans_console_behind_tunnel" {
  command = plan

  assert {
    condition     = output.console_url == "https://console.camellia-deploy.app"
    error_message = "콘솔 주소는 console.<도메인> 이어야 한다."
  }

  assert {
    condition     = aws_instance.host.metadata_options[0].http_tokens == "required" && aws_instance.host.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDSv2 강제 + hop limit 1 이어야 컨테이너가 인스턴스 역할에 닿지 못한다."
  }

  assert {
    condition     = strcontains(aws_instance.host.user_data, "CAMELLIA_SSM_PREFIX='/camellia/platform/env'") && strcontains(aws_instance.host.user_data, "deploy.sh\" 'main'")
    error_message = "user-data 는 SSM 경로를 설정하고 deploy.sh 로 main 을 배포해야 한다."
  }

  assert {
    condition     = aws_instance.host.root_block_device[0].encrypted && aws_instance.host.root_block_device[0].volume_type == "gp3"
    error_message = "루트 볼륨은 암호화된 gp3 여야 한다."
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.console.config.ingress[0].service == "http://web:8080"
    error_message = "Tunnel 은 compose 의 web(nginx) 으로만 보내야 한다."
  }

  assert {
    condition     = cloudflare_dns_record.console.content == "11111111-2222-3333-4444-555555555555.cfargotunnel.com" && cloudflare_dns_record.console.proxied
    error_message = "콘솔 DNS 는 Tunnel 로 가는 proxied CNAME 이어야 한다."
  }

  assert {
    condition     = aws_ssm_parameter.tunnel_token.name == "/camellia/platform/env/CLOUDFLARE_TUNNEL_TOKEN" && aws_ssm_parameter.tunnel_token.type == "SecureString"
    error_message = "Tunnel token 은 플랫폼 env 경로에 SecureString 으로 들어가야 한다."
  }

  assert {
    condition     = contains(data.aws_iam_policy_document.read_env.statement[0].resources, "arn:aws:ssm:ap-northeast-2:123456789012:parameter/camellia/platform/env/*")
    error_message = "인스턴스 역할은 플랫폼 env 경로만 읽어야 한다."
  }
}

run "rejects_user_app_subdomain" {
  command = plan

  variables {
    console_subdomain = "apps"
  }

  expect_failures = [var.console_subdomain]
}

run "rejects_trailing_slash_prefix" {
  command = plan

  variables {
    ssm_parameter_prefix = "/camellia/platform/env/"
  }

  expect_failures = [var.ssm_parameter_prefix]
}
