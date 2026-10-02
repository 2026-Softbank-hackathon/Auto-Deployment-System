# aws-static-basic Terraform profile

This module hosts a static site on AWS without servers: one S3 bucket with static website hosting, read through the platform Cloudflare edge. The worker picks this profile automatically when the analyzed IR has a single `static` service and the target is AWS.

## How a deploy works

1. The Build Handler builds one image for every target: nginx (alpine) with the built files in `/usr/share/nginx/html`. On-prem runs that image as a container.
2. This module creates the bucket and its website configuration. The worker then extracts the files from the same image digest and syncs them to the bucket (changed files only, HTML last, removed files deleted). Rollback and environment switches re-sync from the older digest.
3. The worker verifies the S3 website endpoint directly, then points the Cloudflare service hostname at it (proxied CNAME).

## Fixed choices

- The bucket is named exactly like the public hostname (`service-<project>.<platform domain>`). S3 website endpoints find the bucket from the Host header, and Cloudflare forwards the public hostname.
- Reads are allowed only from the published Cloudflare ranges (`cloudflare_ip_ranges`, kept static so plans need no network) and the worker egress IP (`verifier_cidrs`) used for direct verification. Public ACLs stay blocked.
- S3 website endpoints are HTTP only; public HTTPS terminates at Cloudflare.
- With `spa_fallback` the error document is `index.html`, so client-side routes render, but S3 keeps the 404 status code for those paths.
- `force_destroy = true` so app deletion and profile switches can remove a non-empty bucket.
- `resource_name`, `container_image`, `environment_variables`, `secret_references` are accepted for the common provision/teardown inputs and are not used.

## Local validation

```bash
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test
```
