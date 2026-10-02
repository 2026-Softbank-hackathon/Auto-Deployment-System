variable "app_name" {
  type        = string
  description = "IR metadata.name; used for tags."

  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]{1,255}$", var.app_name))
    error_message = "app_name must contain only letters, numbers, hyphens, or underscores."
  }
}

variable "region" {
  type        = string
  description = "AWS region selected by the environment or IR."
}

variable "bucket_name" {
  type        = string
  description = "Public hostname of the service (service-<project>.<platform domain>). S3 website endpoints pick the bucket from the Host header, so the bucket must be named exactly like the hostname Cloudflare proxies."

  validation {
    condition = (
      length(var.bucket_name) >= 3 &&
      length(var.bucket_name) <= 63 &&
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.bucket_name)) &&
      !strcontains(var.bucket_name, "..")
    )
    error_message = "bucket_name must be a valid S3 bucket name (3-63 lowercase letters, numbers, dots, hyphens)."
  }
}

variable "spa_fallback" {
  type        = bool
  description = "Serve index.html for unknown paths (single page app client routing)."
  default     = true
}

variable "cloudflare_ip_ranges" {
  type        = list(string)
  description = "Cloudflare edge ranges allowed to read objects. Published at https://www.cloudflare.com/ips-v4 and /ips-v6 (checked 2026-10-02); kept static so plans need no network call."
  default = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ]
}

variable "verifier_cidrs" {
  type        = list(string)
  description = "Extra source ranges allowed to read objects: the platform worker's egress IP, so it can verify the S3 website endpoint before switching Cloudflare DNS."
  default     = []

  validation {
    condition     = alltrue([for cidr in var.verifier_cidrs : can(cidrhost(cidr, 0))])
    error_message = "verifier_cidrs must contain CIDR blocks."
  }
}

# provision · teardown 이 모든 AWS 프로필에 넘기는 공통 입력. 이 프로필은 쓰지 않는다.
variable "resource_name" {
  type        = string
  description = "Stable project/environment-scoped name (unused; the bucket is named after the public hostname)."
  default     = ""
}

variable "container_image" {
  type        = string
  description = "Built image digest (unused; files are synced from this image by the worker, not by Terraform)."
  default     = ""
}

variable "environment_variables" {
  type        = map(string)
  description = "Unused; static files do not read runtime environment variables."
  default     = {}
}

variable "secret_references" {
  type        = map(string)
  description = "Unused; static files do not read runtime secrets."
  default     = {}
}
