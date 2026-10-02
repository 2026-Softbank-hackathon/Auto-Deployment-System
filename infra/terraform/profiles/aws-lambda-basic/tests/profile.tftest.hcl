mock_provider "aws" {}

variables {
  app_name        = "demo-web"
  resource_name   = "demo-p1"
  region          = "ap-northeast-2"
  container_image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  container_port  = 3000
}

run "plans_http_app_as_lambda_behind_alb" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    health_check_path = "/healthz"
    environment_variables = {
      DATABASE_URL = "postgres://example"
      AWS_REGION   = "ap-northeast-2"
      NODE_ENV     = "production"
    }
  }

  assert {
    condition     = aws_lambda_function.app.image_uri == var.container_image && aws_lambda_function.app.package_type == "Image"
    error_message = "The function must run the exact immutable image digest as a container image."
  }

  assert {
    condition     = aws_lambda_function.app.architectures == tolist(["x86_64"])
    error_message = "Images are built for linux/amd64, so the function must be x86_64."
  }

  assert {
    condition     = aws_lambda_function.app.memory_size == 512 && aws_lambda_function.app.timeout == 30
    error_message = "Defaults must be 512 MiB memory and a 30s timeout."
  }

  assert {
    condition     = aws_lambda_function.app.publish
    error_message = "Each image update must publish a version for the live alias."
  }

  assert {
    condition     = aws_lambda_function.app.reserved_concurrent_executions == null
    error_message = "Reserved concurrency must stay unset."
  }

  assert {
    condition = (
      aws_lambda_function.app.environment[0].variables["AWS_LWA_PORT"] == "3000" &&
      aws_lambda_function.app.environment[0].variables["AWS_LWA_READINESS_CHECK_PATH"] == "/healthz"
    )
    error_message = "The Lambda Web Adapter must forward to the app port and wait for the IR health path."
  }

  assert {
    condition = (
      aws_lambda_function.app.environment[0].variables["DATABASE_URL"] == "postgres://example" &&
      aws_lambda_function.app.environment[0].variables["NODE_ENV"] == "production"
    )
    error_message = "Project environment variables must reach the function."
  }

  assert {
    condition     = !contains(keys(aws_lambda_function.app.environment[0].variables), "AWS_REGION")
    error_message = "Lambda reserved names such as AWS_REGION must be dropped."
  }

  assert {
    condition     = aws_lb_target_group.function[0].target_type == "lambda" && aws_lb_target_group.function[0].health_check[0].enabled == false
    error_message = "The ALB must target the function without periodic health check invocations."
  }

  assert {
    condition     = aws_lb_listener.http[0].port == 80 && aws_lb_listener.http[0].protocol == "HTTP"
    error_message = "The public origin must stay an HTTP ALB like aws-ecs-basic (Cloudflare terminates HTTPS)."
  }

  assert {
    condition     = aws_lb.app[0].name == var.resource_name && aws_lb_target_group.function[0].name == "demo-p1-fn"
    error_message = "The ALB keeps the aws-ecs-basic name; the target group uses a different name so a profile switch can replace it."
  }

  assert {
    condition     = aws_lambda_alias.live.name == "live" && aws_lambda_permission.alb[0].qualifier == "live"
    error_message = "The ALB must invoke the live alias."
  }

  assert {
    condition     = aws_lambda_function.app.logging_config[0].log_group == "/camellia/demo-p1"
    error_message = "Function logs go to the same log group name as aws-ecs-basic."
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
    container_image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo:latest"
  }

  expect_failures = [var.container_image]
}

run "rejects_unsupported_memory_size" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    memory_size = 3000
  }

  expect_failures = [var.memory_size]
}

run "rejects_internal_only_service" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    public_ingress = false
  }

  expect_failures = [var.public_ingress]
}

run "rejects_secret_references" {
  command = plan

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  variables {
    secret_references = {
      API_KEY = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:api"
    }
  }

  expect_failures = [var.secret_references]
}
