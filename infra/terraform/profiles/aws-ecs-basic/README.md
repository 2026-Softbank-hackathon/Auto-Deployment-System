# aws-ecs-basic Terraform profile

This module provisions the P0 AWS runtime: a two-AZ VPC with public subnets, an Application Load Balancer, and an ECS Fargate service. It receives an immutable image reference from the Build Handler and returns the ALB origin for direct verification and Cloudflare routing.

## Fixed P0 choices

- Two public subnets and an Internet Gateway; no NAT Gateway is created.
- Fargate tasks receive public IPs but accept inbound application traffic only from the ALB security group.
- Terraform waits for the ECS service to reach steady state before returning the ALB origin to Verify.
- The ALB accepts HTTP on port 80. Public HTTPS is expected at the platform Cloudflare edge; `tls_enabled` is retained as an Adapter contract flag and does not create an ALB certificate.
- ECS deployment circuit breaker rollback is enabled. CloudWatch logs are retained for seven days.
- `environment_variables` carries non-sensitive project env vars into the ECS task definition. Keep sensitive values in `secret_references`, which accepts pre-existing Secrets Manager ARNs only; it never accepts values. Connecting the project Secret Store to AWS-side secret provisioning is a separate integration and is not implemented by this module.
- `origin_url` is an HTTP origin. The stable public HTTPS hostname is owned by the platform DNS flow.

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
