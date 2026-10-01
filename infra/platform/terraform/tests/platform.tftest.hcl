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
  mock_data "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }
  mock_resource "aws_instance" {
    override_during = plan
    defaults = {
      arn = "arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0123456789abcdef0"
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

run "plans_github_cd_role" {
  command = plan

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 1 && aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com" && contains(aws_iam_openid_connect_provider.github[0].client_id_list, "sts.amazonaws.com")
    error_message = "기본값은 GitHub OIDC provider 를 만들고 audience 는 sts.amazonaws.com 이어야 한다."
  }

  assert {
    condition     = aws_iam_role.github_cd.name == "camellia-platform-github-cd"
    error_message = "CD 역할 이름은 <name_prefix>-github-cd 여야 한다."
  }

  assert {
    condition = alltrue([
      for c in data.aws_iam_policy_document.github_cd_assume.statement[0].condition :
      c.test == "StringEquals" && (
        (c.variable == "token.actions.githubusercontent.com:aud" && tolist(c.values) == tolist(["sts.amazonaws.com"])) ||
        (c.variable == "token.actions.githubusercontent.com:sub" && tolist(c.values) == tolist(["repo:2026-Softbank-hackathon@335012022/Auto-Deployment-System@1396159841:ref:refs/heads/main"]))
      )
    ]) && length(data.aws_iam_policy_document.github_cd_assume.statement[0].condition) == 2
    error_message = "CD 역할은 aud = sts.amazonaws.com, sub = 이 리포 main 브랜치(StringEquals)로만 받을 수 있어야 한다."
  }

  assert {
    condition = (
      tolist(data.aws_iam_policy_document.github_cd.statement[0].actions) == tolist(["ssm:SendCommand"]) &&
      toset(data.aws_iam_policy_document.github_cd.statement[0].resources) == toset([
        "arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0123456789abcdef0",
        "arn:aws:ssm:ap-northeast-2::document/AWS-RunShellScript",
      ])
    )
    error_message = "SendCommand 는 플랫폼 인스턴스와 AWS-RunShellScript 문서로만 제한해야 한다."
  }

  assert {
    condition     = toset(data.aws_iam_policy_document.github_cd.statement[1].actions) == toset(["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:DescribeInstanceInformation"])
    error_message = "리소스 \"*\" 문장에는 읽기 전용 조회 API 만 있어야 한다."
  }

  assert {
    condition     = length(data.aws_iam_policy_document.github_cd.statement) == 2
    error_message = "CD 역할 권한은 두 문장(SendCommand · 결과 조회)뿐이어야 한다."
  }
}

run "reuses_existing_github_oidc_provider" {
  command = plan

  variables {
    create_github_oidc_provider = false
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0 && length(data.aws_iam_openid_connect_provider.github) == 1
    error_message = "create_github_oidc_provider = false 면 provider 를 만들지 않고 조회만 해야 한다."
  }
}

run "rejects_wildcard_oidc_subject" {
  command = plan

  variables {
    github_oidc_sub_prefix = "repo:2026-Softbank-hackathon/*"
  }

  expect_failures = [var.github_oidc_sub_prefix]
}
