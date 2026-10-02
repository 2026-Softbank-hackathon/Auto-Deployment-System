# aws-ecs-basic Terraform profile

This module provisions the P0 AWS runtime: a two-AZ VPC with public subnets, an Application Load Balancer, and an ECS Fargate service. It receives an immutable image reference from the Build Handler and returns the ALB origin for direct verification and Cloudflare routing.

## Fixed P0 choices

- Two public subnets and an Internet Gateway; no NAT Gateway is created.
- Fargate tasks receive public IPs but accept inbound application traffic only from the ALB security group.
- Terraform does not wait for ECS steady state (`wait_for_steady_state = false`). The worker waits for the rollout itself after apply: it polls the ECS service until the new deployment completes or its tasks are healthy in the target group, logs progress and stopped-task reasons, and only then starts Verify.
- Fast rollout settings: target group health check every 5s (timeout 4s, healthy 2, unhealthy 3), `deregistration_delay = 5`, and a 10s `health_check_grace_period_seconds`. An app must answer its health check within roughly 25s of starting, or ECS replaces the task.
- The ALB accepts HTTP on port 80. Public HTTPS is expected at the platform Cloudflare edge; `tls_enabled` is retained as an Adapter contract flag and does not create an ALB certificate.
- ECS deployment circuit breaker rollback is enabled. CloudWatch logs are retained for seven days.
- `environment_variables` carries non-sensitive project env vars into the ECS task definition. Keep sensitive values in `secret_references`, which accepts pre-existing Secrets Manager ARNs only; it never accepts values. Connecting the project Secret Store to AWS-side secret provisioning is a separate integration and is not implemented by this module.
- `origin_url` is an HTTP origin. The stable public HTTPS hostname is owned by the platform DNS flow.

## PostgreSQL add-on (`database.tf`)

Enabled with `database_enabled = true` when the IR has a `postgres` resource (the Adapter sets it; the worker also keeps it on once an environment has created a database, so a later version without the resource does not drop the data).

- Two private subnets (`10.42.101.0/24`, `10.42.102.0/24` by default) with a route table that has no Internet route, a DB subnet group, and a security group that accepts 5432 only from the ECS service security group.
- RDS PostgreSQL 16 on `db.t4g.micro`, single-AZ, 20 GiB gp3, encrypted at rest, not publicly accessible. No automated backups, `skip_final_snapshot = true` and `deletion_protection = false` so app deletion (`terraform destroy`) removes it quickly. These are hackathon cost/time choices.
- The master password is created and stored by RDS in Secrets Manager (`manage_master_user_password`). It never appears in Terraform variables, plan output, or state. RDS rotates it every 7 days by default; running tasks keep the old value until they are replaced.
- The task receives `database_env_name` (default `DATABASE_URL`) as a password-less URL `postgresql://camellia@<host>:5432/app` and `PGPASSWORD` from the managed secret. libpq and node-postgres combine both. The task execution role is allowed to read that secret.
- A parameter group sets `rds.force_ssl = 0`. PostgreSQL 15+ on RDS forces TLS by default, and the RDS CA is not in Node's default trust store, so every app would need certificate settings. The database is reachable only from the service security group inside private subnets.
- Output `database_address` returns the private hostname.

## State backend

The root module declares the S3 backend without account-specific values. The Provision Handler must pass a unique project/environment state key, region, `use_lockfile=true`, encryption, and the selected KMS key during `terraform init`. It must prepare the backend before initialization and keep AWS credentials in the process environment, not backend arguments or plan files.

The Adapter maps the selected `aws-ecs-basic` Profile and IR into these inputs. The Build Handler must provide `container_image` as an immutable `repository@sha256:...` reference. P0 Fargate sizes are restricted to the Profile's 256/512, 512/1024, and 1024/2048 CPU/MiB pairs.

## Local validation

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

Do not run `terraform apply` from this module directory without the authenticated, locked Provision Handler flow.
