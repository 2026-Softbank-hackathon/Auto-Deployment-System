variable "app_name" {
  type        = string
  description = "IR metadata.name; used for the ECS container and tags."

  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]{1,255}$", var.app_name))
    error_message = "app_name must contain only letters, numbers, hyphens, or underscores."
  }
}

variable "resource_name" {
  type        = string
  description = "Stable project/environment-scoped AWS resource name."

  validation {
    condition     = can(regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,27}[a-zA-Z0-9])?$", var.resource_name))
    error_message = "resource_name must be 1-29 alphanumeric or hyphen characters and may not end in a hyphen."
  }
}

variable "region" {
  type        = string
  description = "AWS region selected by the environment or IR."
}

variable "container_image" {
  type        = string
  description = "Immutable ECR image reference, including sha256 digest."

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "container_image must be an immutable sha256 digest reference."
  }
}

variable "container_port" {
  type        = number
  description = "Port exposed by the application container."

  validation {
    condition     = var.container_port >= 1 && var.container_port <= 65535 && floor(var.container_port) == var.container_port
    error_message = "container_port must be an integer from 1 through 65535."
  }
}

variable "task_cpu" {
  type        = number
  description = "Fargate CPU units (1024 units = 1 vCPU)."
}

variable "task_memory" {
  type        = number
  description = "Fargate task memory in MiB."

  validation {
    condition     = contains(["256:512", "512:1024", "1024:2048"], "${var.task_cpu}:${var.task_memory}")
    error_message = "P0 supports the profile sizes 256 CPU/512 MiB, 512 CPU/1024 MiB, and 1024 CPU/2048 MiB."
  }
}

variable "desired_count" {
  type        = number
  description = "Desired number of Fargate tasks."
  default     = 1

  validation {
    condition     = var.desired_count >= 1 && floor(var.desired_count) == var.desired_count
    error_message = "desired_count must be a positive integer."
  }
}

variable "health_check_path" {
  type        = string
  description = "IR HTTP health check path used by the ALB target group."
  default     = "/health"

  validation {
    condition     = startswith(var.health_check_path, "/") && !strcontains(var.health_check_path, " ")
    error_message = "health_check_path must be an absolute HTTP path."
  }
}

variable "health_check_expected_status" {
  type        = number
  description = "Expected HTTP status from the IR health check."
  default     = 200

  validation {
    condition     = var.health_check_expected_status >= 200 && var.health_check_expected_status <= 499 && floor(var.health_check_expected_status) == var.health_check_expected_status
    error_message = "ALB health checks support an integer status from 200 through 499."
  }
}

variable "public_ingress" {
  type        = bool
  description = "Whether the profile exposes the service through a public ALB."
  default     = true
}

variable "tls_enabled" {
  type        = bool
  description = "Public TLS is terminated at the Cloudflare platform edge; this ALB origin remains HTTP."
  default     = true
}

variable "secret_references" {
  type        = map(string)
  description = "Environment variable name to AWS Secrets Manager ARN. Values remain outside Terraform variables/state."
  default     = {}
}

variable "environment_variables" {
  type        = map(string)
  description = "Non-sensitive project environment values keyed by environment variable name."
  default     = {}
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR used for the P0 two-AZ public VPC."
  default     = "10.42.0.0/16"
}
