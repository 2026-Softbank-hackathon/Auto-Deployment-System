locals {
  # Lambda 가 직접 정하는 이름 — 사용자가 넣으면 함수 생성 · 갱신이 거절된다 (AWS_REGION 은 Lambda 가 같은 값으로 넣는다)
  lambda_reserved_environment_names = [
    "_HANDLER", "_X_AMZN_TRACE_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_EXECUTION_ENV",
    "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "AWS_LAMBDA_FUNCTION_VERSION",
    "AWS_LAMBDA_INITIALIZATION_TYPE", "AWS_LAMBDA_LOG_GROUP_NAME", "AWS_LAMBDA_LOG_STREAM_NAME",
    "AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR",
  ]

  function_environment = merge(
    { for name, value in var.environment_variables : name => value if !contains(local.lambda_reserved_environment_names, name) },
    {
      # Lambda Web Adapter(이미지의 /opt/extensions/lambda-adapter)가 요청을 넘길 포트와 첫 요청 전 준비 확인 경로
      AWS_LWA_PORT                 = tostring(var.container_port)
      AWS_LWA_READINESS_CHECK_PATH = var.health_check_path
    },
  )
}

# aws-ecs-basic 과 같은 주소 · 이름 — 컨테이너 ↔ 서버리스 전환 때 로그 그룹이 이어진다
resource "aws_cloudwatch_log_group" "app" {
  name              = "/camellia/${var.resource_name}"
  retention_in_days = 7

  tags = local.tags
}

resource "aws_iam_role" "function" {
  name_prefix = "${var.resource_name}-fn-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "logs" {
  name_prefix = "${var.resource_name}-logs-"
  role        = aws_iam_role.function.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.app.arn}:*"
    }]
  })
}

resource "aws_lambda_function" "app" {
  function_name = var.resource_name
  role          = aws_iam_role.function.arn
  package_type  = "Image"
  image_uri     = var.container_image
  architectures = ["x86_64"]
  memory_size   = var.memory_size
  timeout       = var.timeout
  # 이미지가 바뀌면 새 버전을 발행하고 alias 가 그 버전을 가리킨다 (ALB 는 alias 를 호출)
  publish = true

  environment {
    variables = local.function_environment
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.app.name
  }

  tags = local.tags

  depends_on = [aws_iam_role_policy.logs]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.app.function_name
  function_version = aws_lambda_function.app.version
}

resource "aws_lb" "app" {
  count = var.public_ingress ? 1 : 0

  name               = var.resource_name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = aws_subnet.public[*].id

  tags = merge(local.tags, { Name = var.resource_name })
}

# aws-ecs-basic 의 타깃 그룹(app, ip 타입)과 주소 · 이름을 다르게 둔다 — 전환 때 새 그룹을 만든 뒤
# 리스너를 옮기고 예전 그룹을 지운다 (같은 주소면 리스너가 쓰는 그룹을 먼저 지우려다 실패한다).
resource "aws_lb_target_group" "function" {
  count = var.public_ingress ? 1 : 0

  name        = "${var.resource_name}-fn"
  target_type = "lambda"

  # ALB 헬스체크는 끈다 — 켜면 주기적으로 함수를 호출한다. 준비 확인은 Lambda Web Adapter 가,
  # 배포 검증은 워커가 origin /health 로 한다. 타깃이 하나뿐이라 상태가 unavailable 이어도 ALB 는 보낸다.
  health_check {
    enabled = false
  }

  tags = local.tags
}

resource "aws_lambda_permission" "alb" {
  count = var.public_ingress ? 1 : 0

  statement_id  = "AllowCamelliaAlbInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.function[0].arn
}

resource "aws_lb_target_group_attachment" "function" {
  count = var.public_ingress ? 1 : 0

  target_group_arn = aws_lb_target_group.function[0].arn
  target_id        = aws_lambda_alias.live.arn

  depends_on = [aws_lambda_permission.alb]
}

resource "aws_lb_listener" "http" {
  count = var.public_ingress ? 1 : 0

  load_balancer_arn = aws_lb.app[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.function[0].arn
  }

  # 함수가 타깃으로 붙은 뒤에 리스너를 옮긴다 (컨테이너에서 전환할 때 빈 그룹으로 보내지 않게)
  depends_on = [aws_lb_target_group_attachment.function]
}
