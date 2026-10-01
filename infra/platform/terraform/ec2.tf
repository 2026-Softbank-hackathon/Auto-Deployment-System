data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

# Ubuntu 24.04 LTS (amd64). Docker 공식 저장소(get.docker.com)로 엔진 · buildx · compose 를
# 버전이 맞는 묶음으로 설치하기 위해 Ubuntu 를 쓴다. SSM Agent 는 기본 탑재.
data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  ssm_parameter_arn_prefix = "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_parameter_prefix}"
}

# ── IAM: SSM Session Manager + 플랫폼 env 파라미터 읽기만 ─────────────────────
# 사용자 앱 빌드 · 프로비저닝은 사용자가 등록한 AWS 키로 하므로 인스턴스 역할에는 더 주지 않는다.
data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "${var.name_prefix}-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "read_env" {
  statement {
    sid       = "ReadPlatformEnv"
    actions   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
    resources = [local.ssm_parameter_arn_prefix, "${local.ssm_parameter_arn_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "read_env" {
  name   = "read-platform-env"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.read_env.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name_prefix}-host"
  role = aws_iam_role.host.name
}

# ── EC2 ─────────────────────────────────────────────────────────────────────
resource "aws_instance" "host" {
  ami                    = nonsensitive(data.aws_ssm_parameter.ubuntu_ami.value)
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  # IMDSv2 강제 + hop limit 1: 컨테이너(브리지 네트워크)는 인스턴스 역할 자격증명에 닿지 못한다
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region               = var.region
    git_repository_url   = var.git_repository_url
    git_ref              = var.git_ref
    ssm_parameter_prefix = var.ssm_parameter_prefix
  })

  tags = {
    Name = "${var.name_prefix}-host"
  }

  lifecycle {
    # 새 AMI 가 나오거나 git_ref 를 바꿔도 인스턴스를 갈아엎지 않는다.
    # 갱신은 SSM 으로 scripts/deploy.sh 를 실행한다 (docs/deploy-platform.md).
    ignore_changes = [ami, user_data]
  }

  # Tunnel token 이 SSM 에 들어간 뒤 부팅해야 첫 deploy.sh 가 성공한다
  depends_on = [
    aws_ssm_parameter.tunnel_token,
    aws_iam_role_policy.read_env,
    aws_route_table_association.public,
  ]
}
