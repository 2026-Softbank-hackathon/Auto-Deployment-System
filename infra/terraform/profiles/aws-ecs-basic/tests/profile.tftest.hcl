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
