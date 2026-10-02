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

run "creates_no_database_by_default" {
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
    task_memory     = 512
  }

  assert {
    condition     = length(aws_db_instance.database) == 0 && length(aws_subnet.private) == 0
    error_message = "Without a postgres resource the profile must not create RDS or private subnets."
  }

  assert {
    condition     = length([for entry in jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment : entry if entry.name == "DATABASE_URL"]) == 0
    error_message = "DATABASE_URL must not be injected without a database."
  }
}

run "adds_private_postgres_and_injects_connection" {
  command = apply

  override_data {
    target = data.aws_availability_zones.available
    values = {
      names = ["ap-northeast-2a", "ap-northeast-2b"]
    }
  }

  override_resource {
    target = aws_db_instance.database
    values = {
      address = "cam-demo-db.abc123.ap-northeast-2.rds.amazonaws.com"
      port    = 5432
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-1234-AbCdEf"
        secret_status = "active"
        kms_key_id    = ""
      }]
    }
  }

  override_resource {
    target = aws_iam_role.task_execution
    values = {
      arn = "arn:aws:iam::123456789012:role/demo-exec"
    }
  }

  variables {
    app_name          = "demo-web"
    resource_name     = "Demo-P0"
    region            = "ap-northeast-2"
    container_image   = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/demo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    container_port    = 3000
    task_cpu          = 256
    task_memory       = 512
    database_enabled  = true
    database_env_name = "DATABASE_URL"
    # mock provider 의 ALB ARN 은 형식 검사를 통과하지 못한다 — DB 연결만 확인하므로 ALB 없이 apply
    public_ingress = false
    environment_variables = {
      NODE_ENV = "production"
    }
  }

  assert {
    condition = (
      aws_db_instance.database[0].engine == "postgres" &&
      aws_db_instance.database[0].instance_class == "db.t4g.micro" &&
      aws_db_instance.database[0].multi_az == false &&
      aws_db_instance.database[0].storage_encrypted == true &&
      aws_db_instance.database[0].publicly_accessible == false
    )
    error_message = "The database must be a single-AZ, encrypted, private db.t4g.micro PostgreSQL instance."
  }

  assert {
    condition     = aws_db_instance.database[0].identifier == "demo-p0-db" && aws_db_subnet_group.database[0].name == "demo-p0-db"
    error_message = "RDS identifiers must be lowercase."
  }

  assert {
    condition = (
      aws_db_instance.database[0].manage_master_user_password == true &&
      aws_db_instance.database[0].password == null
    )
    error_message = "RDS must manage the master password in Secrets Manager so it never enters Terraform state."
  }

  assert {
    condition = (
      aws_db_instance.database[0].skip_final_snapshot == true &&
      aws_db_instance.database[0].deletion_protection == false
    )
    error_message = "App deletion must be able to destroy the hackathon database without a final snapshot."
  }

  assert {
    condition     = length(aws_subnet.private) == 2 && alltrue([for subnet in aws_subnet.private : subnet.map_public_ip_on_launch == false])
    error_message = "The database must live in two private subnets."
  }

  assert {
    condition     = length(aws_route_table.private[0].route) == 0
    error_message = "Private subnets must not route to the Internet Gateway."
  }

  assert {
    condition = (
      one(aws_security_group.database[0].ingress).from_port == 5432 &&
      one(one(aws_security_group.database[0].ingress).security_groups) == aws_security_group.service.id &&
      length(coalesce(one(aws_security_group.database[0].ingress).cidr_blocks, [])) == 0
    )
    error_message = "Only the ECS service security group may reach PostgreSQL."
  }

  assert {
    condition     = one([for parameter in aws_db_parameter_group.database[0].parameter : parameter.value if parameter.name == "rds.force_ssl"]) == "0"
    error_message = "The private database accepts plain connections so any PostgreSQL client works with DATABASE_URL."
  }

  assert {
    condition = contains(
      jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment,
      { name = "DATABASE_URL", value = "postgresql://camellia@cam-demo-db.abc123.ap-northeast-2.rds.amazonaws.com:5432/app" }
    )
    error_message = "The task must receive DATABASE_URL without a password."
  }

  assert {
    condition = contains(
      jsondecode(aws_ecs_task_definition.app.container_definitions)[0].environment,
      { name = "NODE_ENV", value = "production" }
    )
    error_message = "Project environment variables must still be injected."
  }

  assert {
    condition = contains(
      jsondecode(aws_ecs_task_definition.app.container_definitions)[0].secrets,
      { name = "PGPASSWORD", valueFrom = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-1234-AbCdEf:password::" }
    )
    error_message = "The password must come from the RDS-managed secret as PGPASSWORD."
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.read_secrets[0].policy, "rds!db-1234-AbCdEf")
    error_message = "The task execution role must be able to read the RDS-managed secret."
  }

  assert {
    condition     = output.database_address == "cam-demo-db.abc123.ap-northeast-2.rds.amazonaws.com"
    error_message = "The module must expose the database address."
  }
}

run "rejects_invalid_database_env_name" {
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
    database_enabled  = true
    database_env_name = "database url"
  }

  expect_failures = [var.database_env_name]
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
