mock_provider "aws" {}

run "plans_http_app_with_immutable_digest" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    app_name          = "demo-web"
    resource_name     = "demo-p0"
    region            = "ap-northeast-2"
    container_image   = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    container_port    = 3000
    task_cpu          = 256
    task_memory       = 512
    health_check_path = "/health"
  }

  assert {
    condition     = aws_lb_listener.http[0].port == 80
    error_message = "The public P0 profile must expose its ALB origin over HTTP."
  }

  assert {
    condition     = aws_lb_target_group.app[0].health_check[0].path == "/health"
    error_message = "The target group must use the IR health check path."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].image == var.container_image
    error_message = "The ECS task definition must use the exact immutable image digest."
  }

  assert {
    condition     = aws_ecs_service.app.wait_for_steady_state == false
    error_message = "The worker waits for the ECS rollout itself, so Terraform must not block on steady state."
  }

  assert {
    condition     = aws_ecs_service.app.deployment_circuit_breaker[0].enable && aws_ecs_service.app.deployment_circuit_breaker[0].rollback
    error_message = "The ECS deployment circuit breaker must stay enabled with rollback."
  }

  assert {
    condition     = aws_ecs_service.app.health_check_grace_period_seconds == 10
    error_message = "The ECS service must ignore ALB health checks only for a short 10s grace period."
  }

  assert {
    condition = (
      aws_lb_target_group.app[0].health_check[0].interval == 5 &&
      aws_lb_target_group.app[0].health_check[0].healthy_threshold == 2 &&
      aws_lb_target_group.app[0].health_check[0].unhealthy_threshold == 3 &&
      aws_lb_target_group.app[0].health_check[0].timeout == 4
    )
    error_message = "The target group health check must be 5s interval, 2 healthy, 3 unhealthy, 4s timeout."
  }

  assert {
    condition     = aws_lb_target_group.app[0].health_check[0].timeout < aws_lb_target_group.app[0].health_check[0].interval
    error_message = "The health check timeout must be shorter than its interval."
  }

  assert {
    condition     = tonumber(aws_lb_target_group.app[0].deregistration_delay) == 5
    error_message = "Old tasks must drain from the target group within 5 seconds."
  }
}

run "rejects_mutable_image_reference" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    app_name        = "demo-web"
    resource_name   = "demo-p0"
    region          = "ap-northeast-2"
    container_image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo:latest"
    container_port  = 3000
    task_cpu        = 256
    task_memory     = 512
  }

  expect_failures = [var.container_image]
}

run "rejects_unsupported_fargate_size" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    app_name        = "demo-web"
    resource_name   = "demo-p0"
    region          = "ap-northeast-2"
    container_image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    container_port  = 3000
    task_cpu        = 256
    task_memory     = 2048
  }

  expect_failures = [var.task_memory]
}
