resource "aws_cloudwatch_log_group" "app" {
  name              = "/camellia/${var.resource_name}"
  retention_in_days = 7

  tags = local.tags
}

resource "aws_iam_role" "task_execution" {
  name_prefix = "${var.resource_name}-exec-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "read_secrets" {
  count = length(var.secret_references) > 0 || var.database_enabled ? 1 : 0

  name_prefix = "${var.resource_name}-secrets-"
  role        = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = concat(values(var.secret_references), local.database_secret_arns)
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = var.resource_name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = local.tags
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.resource_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn

  container_definitions = jsonencode([{
    name      = var.app_name
    image     = var.container_image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [
      for name, value in merge(var.environment_variables, local.database_environment) : {
        name  = name
        value = value
      }
    ]
    secrets = [
      for name, value_from in merge(var.secret_references, local.database_secrets) : {
        name      = name
        valueFrom = value_from
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])

  tags = local.tags
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

resource "aws_lb_target_group" "app" {
  count = var.public_ingress ? 1 : 0

  name        = "${var.resource_name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  # 교체 배포 때 이전 태스크가 빨리 빠지도록 기본 300초 대신 5초만 드레이닝한다.
  deregistration_delay = 5

  # 새 태스크가 빨리 healthy 가 되도록 5초 간격으로 확인한다 (timeout 은 interval 보다 짧아야 한다).
  health_check {
    enabled             = true
    path                = var.health_check_path
    matcher             = tostring(var.health_check_expected_status)
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 5
    timeout             = 4
  }

  tags = local.tags
}

resource "aws_lb_listener" "http" {
  count = var.public_ingress ? 1 : 0

  load_balancer_arn = aws_lb.app[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}

resource "aws_ecs_service" "app" {
  name            = var.resource_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # 롤아웃 완료는 워커가 ECS 를 직접 확인해 기다린다 (apps/worker/src/ecs-rollout.ts).
  # Terraform 은 서비스 갱신만 하고 바로 돌아온다.
  wait_for_steady_state = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  dynamic "load_balancer" {
    for_each = var.public_ingress ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.app[0].arn
      container_name   = var.app_name
      container_port   = var.container_port
    }
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }

  health_check_grace_period_seconds = var.public_ingress ? 10 : null

  depends_on = [
    aws_lb_listener.http,
    aws_iam_role_policy_attachment.task_execution,
    aws_iam_role_policy.read_secrets,
  ]

  tags = local.tags
}
