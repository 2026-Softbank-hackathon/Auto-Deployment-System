# GitHub Actions 로 이 Terraform 을 plan · apply 하는 역할 (.github/workflows/terraform-platform.yml)
#   - tf-plan : PR · main 에서 받는다. 읽기 전용 + state 읽기 + Cloudflare token 읽기 → PR 에 plan 코멘트
#   - tf-apply: main 에서만 받는다. 이 설정이 관리하는 리소스 종류만 생성 · 변경 · 삭제
# 두 역할은 사람이 한 번 terraform apply 로 만들어야 워크플로가 동작한다 (docs/deploy-platform.md 8절).
# OIDC provider · locals(github_oidc_host, github_oidc_provider_arn)는 github-cd.tf 와 같은 것을 쓴다.

variable "tf_state_bucket" {
  description = "이 설정의 S3 backend bucket. backend.tf 와 같아야 한다 (backend 블록은 변수를 못 써서 따로 둔다)"
  type        = string
  default     = "camellia-tfstate-725072160743"
}

variable "tf_state_key" {
  description = "이 설정의 S3 backend state key. backend.tf 와 같아야 한다. 잠금 파일은 <key>.tflock"
  type        = string
  default     = "camellia/platform/terraform.tfstate"
}

locals {
  tf_state_bucket_arn = "arn:${data.aws_partition.current.partition}:s3:::${var.tf_state_bucket}"
  tf_state_object_arn = "${local.tf_state_bucket_arn}/${var.tf_state_key}"
  tf_lock_object_arn  = "${local.tf_state_object_arn}.tflock"

  github_tf_main_subject = "${var.github_oidc_sub_prefix}:ref:refs/heads/${var.github_cd_branch}"
  github_tf_pr_subject   = "${var.github_oidc_sub_prefix}:pull_request"

  # plan 이 읽는 SecureString 은 둘뿐: Terraform 이 관리하는 Tunnel token, 워크플로가 쓰는 Cloudflare API token
  tf_plan_secure_parameter_arns = [
    "${local.ssm_parameter_arn_prefix}/CLOUDFLARE_TUNNEL_TOKEN",
    "${local.ssm_parameter_arn_prefix}/CLOUDFLARE_API_TOKEN",
  ]

  tf_iam_arn_prefix                   = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}"
  tf_iam_role_arn_pattern             = "${local.tf_iam_arn_prefix}:role/${var.name_prefix}-*"
  tf_iam_instance_profile_arn_pattern = "${local.tf_iam_arn_prefix}:instance-profile/${var.name_prefix}-*"
  tf_github_oidc_provider_arn_static  = "${local.tf_iam_arn_prefix}:oidc-provider/${local.github_oidc_host}"
}

# ── 신뢰 정책 ────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "github_tf_plan_assume" {
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

    # 같은 리포 브랜치에서 연 PR + main. fork PR 은 GitHub 가 id-token 을 주지 않는다
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.github_tf_pr_subject, local.github_tf_main_subject]
    }
  }
}

data "aws_iam_policy_document" "github_tf_apply_assume" {
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

    # main 에서 돈 워크플로만 (= 리뷰 · 머지된 코드)
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = [local.github_tf_main_subject]
    }
  }
}

# ── 읽기 권한 (plan · apply 공통) ────────────────────────────────────────────
# AWS 관리형 ReadOnlyAccess 는 쓰지 않는다: 계정의 모든 S3 객체(사용자 앱 state 포함)와
# 모든 SSM SecureString(POSTGRES_PASSWORD · API_KEY · SECRET_MASTER_KEY …)을 읽을 수 있게 되는데,
# plan 역할은 PR(리뷰 전 코드)에서 받을 수 있기 때문이다.
data "aws_iam_policy_document" "github_tf_read" {
  statement {
    sid       = "StateList"
    actions   = ["s3:ListBucket"]
    resources = [local.tf_state_bucket_arn]
  }

  statement {
    sid       = "StateRead"
    actions   = ["s3:GetObject"]
    resources = [local.tf_state_object_arn]
  }

  # use_lockfile: <key>.tflock 를 만들고 지운다 (CI plan 은 -lock=false 라 쓰지 않지만 로컬 plan 과 같게)
  statement {
    sid       = "StateLock"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [local.tf_lock_object_arn]
  }

  # EC2 Describe* 는 리소스 수준 권한을 지원하지 않는다
  statement {
    sid       = "Ec2Describe"
    actions   = ["ec2:Describe*"]
    resources = ["*"]
  }

  statement {
    sid = "IamRead"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:GetInstanceProfile",
      "iam:GetOpenIDConnectProvider",
    ]
    resources = [
      local.tf_iam_role_arn_pattern,
      local.tf_iam_instance_profile_arn_pattern,
      local.tf_github_oidc_provider_arn_static,
    ]
  }

  # create_github_oidc_provider = false 일 때 data source 가 목록을 조회한다
  statement {
    sid       = "IamListOidcProviders"
    actions   = ["iam:ListOpenIDConnectProviders"]
    resources = ["*"]
  }

  statement {
    sid       = "SsmDescribe"
    actions   = ["ssm:DescribeParameters"]
    resources = ["*"]
  }

  # 플랫폼 env 중 이 둘만 읽는다 (DB 비밀번호 · API Key 등은 못 읽음) + Ubuntu AMI 공개 파라미터
  statement {
    sid     = "SsmRead"
    actions = ["ssm:GetParameter", "ssm:GetParameters", "ssm:ListTagsForResource"]
    resources = concat(local.tf_plan_secure_parameter_arns, [
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}:*:parameter/aws/service/canonical/*",
    ])
  }

  # SecureString 복호화 (aws/ssm 키). SSM 경유 + 위 두 파라미터의 암호화 컨텍스트로만
  statement {
    sid       = "KmsDecryptSsm"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = local.tf_plan_secure_parameter_arns
    }
  }
}

# ── 쓰기 권한 (apply 만) ─────────────────────────────────────────────────────
# 이 설정의 리소스 종류(VPC · 서브넷 · IGW · 라우트 테이블 · SG · EC2 · IAM · SSM)만.
# 주의: camellia-platform-* IAM 역할을 고칠 수 있으므로 자기 권한도 넓힐 수 있다 (사실상 관리자 상당).
# 그래서 신뢰 정책을 main 브랜치로만 제한한다 — main 보호(PR 리뷰)가 실질적인 경계다.
data "aws_iam_policy_document" "github_tf_write" {
  statement {
    sid       = "StateWrite"
    actions   = ["s3:PutObject"]
    resources = [local.tf_state_object_arn]
  }

  # 생성 · 연결 계열: 새 리소스라 태그 조건을 걸 수 없어 리전으로만 제한
  statement {
    sid = "Ec2CreateInRegion"
    actions = [
      "ec2:RunInstances",
      "ec2:CreateVpc",
      "ec2:CreateSubnet",
      "ec2:CreateInternetGateway",
      "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway",
      "ec2:CreateRouteTable",
      "ec2:CreateRoute",
      "ec2:ReplaceRoute",
      "ec2:DeleteRoute",
      "ec2:AssociateRouteTable",
      "ec2:DisassociateRouteTable",
      "ec2:ReplaceRouteTableAssociation",
      "ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:ModifySecurityGroupRules",
      "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  # 생성과 동시에 붙이는 태그(TagSpecifications)만 허용 — 남의 리소스에 태그를 붙여 아래 조건을 우회하지 못하게
  statement {
    sid       = "Ec2TagOnCreate"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values = [
        "RunInstances",
        "CreateVpc",
        "CreateSubnet",
        "CreateInternetGateway",
        "CreateRouteTable",
        "CreateSecurityGroup",
        "AuthorizeSecurityGroupEgress",
      ]
    }
  }

  # 삭제 · 변경 계열: default_tags(Project=camellia, Component=platform)가 붙은 리소스만
  # → 같은 계정의 사용자 앱 리소스 등을 실수로 지우거나 바꾸지 못한다
  statement {
    sid = "Ec2ModifyPlatformTagged"
    actions = [
      "ec2:TerminateInstances",
      "ec2:StopInstances",
      "ec2:StartInstances",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyInstanceMetadataOptions",
      "ec2:ModifyInstanceCreditSpecification",
      "ec2:AssociateIamInstanceProfile",
      "ec2:ReplaceIamInstanceProfileAssociation",
      "ec2:DisassociateIamInstanceProfile",
      "ec2:ModifyVolume",
      "ec2:ModifyVpcAttribute",
      "ec2:ModifySubnetAttribute",
      "ec2:DeleteVpc",
      "ec2:DeleteSubnet",
      "ec2:DeleteInternetGateway",
      "ec2:DeleteRouteTable",
      "ec2:DeleteSecurityGroup",
      "ec2:CreateTags",
      "ec2:DeleteTags",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["camellia"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Component"
      values   = ["platform"]
    }
  }

  statement {
    sid = "IamManagePlatformRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListInstanceProfilesForRole",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
    ]
    resources = [local.tf_iam_role_arn_pattern, local.tf_iam_instance_profile_arn_pattern]
  }

  # 인스턴스 프로파일의 역할을 EC2 에만 넘긴다
  statement {
    sid       = "IamPassPlatformRoleToEc2"
    actions   = ["iam:PassRole"]
    resources = [local.tf_iam_role_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  # GitHub OIDC provider 는 이름이 고정이라 ARN 하나로 제한
  statement {
    sid = "IamManageGithubOidcProvider"
    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = [local.tf_github_oidc_provider_arn_static]
  }

  statement {
    sid = "SsmManagePlatformEnv"
    actions = [
      "ssm:PutParameter",
      "ssm:DeleteParameter",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:AddTagsToResource",
      "ssm:RemoveTagsFromResource",
      "ssm:ListTagsForResource",
    ]
    resources = ["${local.ssm_parameter_arn_prefix}/*"]
  }

  statement {
    sid       = "KmsSsmPlatformEnv"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = ["${local.ssm_parameter_arn_prefix}/*"]
    }
  }
}

# ── 역할 ─────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "github_tf_plan" {
  name               = "${var.name_prefix}-tf-plan"
  description        = "GitHub Actions: terraform plan for infra/platform (PR + main, read-only)"
  assume_role_policy = data.aws_iam_policy_document.github_tf_plan_assume.json
}

resource "aws_iam_role_policy" "github_tf_plan_read" {
  name   = "terraform-read"
  role   = aws_iam_role.github_tf_plan.id
  policy = data.aws_iam_policy_document.github_tf_read.json
}

resource "aws_iam_role" "github_tf_apply" {
  name               = "${var.name_prefix}-tf-apply"
  description        = "GitHub Actions: terraform apply for infra/platform (main only)"
  assume_role_policy = data.aws_iam_policy_document.github_tf_apply_assume.json
}

resource "aws_iam_role_policy" "github_tf_apply_read" {
  name   = "terraform-read"
  role   = aws_iam_role.github_tf_apply.id
  policy = data.aws_iam_policy_document.github_tf_read.json
}

resource "aws_iam_role_policy" "github_tf_apply_write" {
  name   = "terraform-write"
  role   = aws_iam_role.github_tf_apply.id
  policy = data.aws_iam_policy_document.github_tf_write.json
}

output "github_tf_plan_role_arn" {
  description = "Terraform plan 역할 ARN → 저장소 변수 AWS_TF_PLAN_ROLE_ARN"
  value       = aws_iam_role.github_tf_plan.arn
}

output "github_tf_apply_role_arn" {
  description = "Terraform apply 역할 ARN → 저장소 변수 AWS_TF_APPLY_ROLE_ARN"
  value       = aws_iam_role.github_tf_apply.arn
}
