# aws-lambda-basic Terraform profile

Serverless deployment form for one public HTTP service. It runs the same immutable ECR image digest that `aws-ecs-basic` and on-prem use, as a Lambda container image. Every platform build adds the AWS Lambda Web Adapter extension (`/opt/extensions/lambda-adapter`) as the last image layer, so no Lambda-specific build is needed.

## Fixed choices

- Lambda function: `package_type = Image`, `x86_64` (images are built for `linux/amd64`), memory from the IR size (small 512 / medium 1024 / large 2048 MiB), 30s timeout, reserved concurrency unset. `publish = true` and a `live` alias; the ALB invokes the alias.
- Lambda Web Adapter settings are function environment variables, not baked into the image: `AWS_LWA_PORT` = IR port, `AWS_LWA_READINESS_CHECK_PATH` = IR health path. Project env vars are passed as-is except names Lambda reserves (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, ...), which Lambda sets itself.
- Public origin is an HTTP ALB with a `lambda` target group (ALB health checks off — they would invoke the function periodically). Not a Lambda Function URL: Cloudflare proxies `service-<id>.<domain>` with that hostname as `Host`, and Function URLs (like API Gateway and CloudFront default domains) route by `Host`, so they reject it. The ALB ignores `Host`, so the existing Cloudflare origin switch, pre-switch verification of `origin_url`, and the fixed public URL work unchanged.
- The VPC, subnets, ALB security group, ALB, listener, and log group use the same resource addresses and names as `aws-ecs-basic`. Both profiles use the same state key (project + environment), so switching container ↔ serverless keeps the VPC and ALB (same origin hostname) and replaces only compute and the target group. The target group has a different address/name (`<resource_name>-fn`) so Terraform creates it, moves the listener (after the function is attached), then deletes the old one.
- The function is not attached to the VPC. Secrets (`secret_references`) are not delivered and must be empty.
- Logs go to `/camellia/<resource_name>` (7 days), the same log group as `aws-ecs-basic`.

## Requirements and limits

- The ECR repository must be in the same account and region. On first create, Lambda adds the repository policy it needs to pull the image; the AWS key must allow `ecr:SetRepositoryPolicy` / `ecr:GetRepositoryPolicy`.
- Lambda limits apply: read-only file system except `/tmp`, 1MB request and response bodies through the ALB, 30s per request, 4KB of environment variables, no long-lived background work between requests, cold starts after idle.
- The ALB still has an hourly cost; only compute is per request.

## Local validation

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test
```

Do not run `terraform apply` from this module directory without the authenticated, locked Provision Handler flow.
