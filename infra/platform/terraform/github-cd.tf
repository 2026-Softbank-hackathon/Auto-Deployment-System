# GitHub Actions CD: main 에 push 되면 .github/workflows/deploy-platform.yml 이 OIDC 로 이 역할을 받아
# SSM Run Command 로 호스트의 scripts/deploy.sh <커밋 SHA> 를 실행한다. 장기 액세스 키 · SSH 없음.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
  github_oidc_provider_arn = (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn
  )
}

# 계정당 URL 하나에 provider 하나만 만들 수 있다. 이미 있으면 create_github_oidc_provider = false 로 조회만 한다.
# thumbprint 는 AWS 가 GitHub 인증서를 직접 검증하므로 넣지 않는다.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1

  url = "https://${local.github_oidc_host}"
}

# 이 리포의 지정 브랜치에서 돈 워크플로만 역할을 받는다 (PR · 다른 브랜치 · fork 불가)
data "aws_iam_policy_document" "github_cd_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = ["${var.github_oidc_sub_prefix}:ref:refs/heads/${var.github_cd_branch}"]
    }
  }
}

resource "aws_iam_role" "github_cd" {
  name               = "${var.name_prefix}-github-cd"
  description        = "GitHub Actions CD: SSM send-command deploy.sh to the platform host"
  assume_role_policy = data.aws_iam_policy_document.github_cd_assume.json
}

data "aws_iam_policy_document" "github_cd" {
  # 플랫폼 인스턴스에 AWS-RunShellScript 만 보낼 수 있다 (두 ARN 이 모두 맞아야 SendCommand 허용)
  statement {
    sid     = "RunDeployScriptOnPlatformHost"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.host.arn,
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }

  # 실행 결과 · 에이전트 상태 조회. 이 API 들은 리소스 수준 권한을 지원하지 않아 "*" 가 필요하다 (읽기 전용)
  statement {
    sid = "ReadCommandResult"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:DescribeInstanceInformation",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_cd" {
  name   = "deploy-platform"
  role   = aws_iam_role.github_cd.id
  policy = data.aws_iam_policy_document.github_cd.json
}
