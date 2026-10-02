variable "app_name" {
  type        = string
  description = "IR metadata.name; used for tags."

  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]{1,255}$", var.app_name))
    error_message = "app_name must contain only letters, numbers, hyphens, or underscores."
  }
}

variable "resource_name" {
  type        = string
  description = "Stable project/environment-scoped AWS resource name (same as aws-ecs-basic, so both profiles share one state key)."

  validation {
    condition     = can(regex("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,27}[a-zA-Z0-9])?$", var.resource_name))
    error_message = "resource_name must be 1-29 alphanumeric or hyphen characters and may not end in a hyphen."
  }
}

variable "region" {
  type        = string
  description = "AWS region selected by the environment. The ECR image must be in this region."
}

variable "container_image" {
  type        = string
  description = "Immutable ECR image reference, including sha256 digest. The image must contain the Lambda Web Adapter extension."

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "container_image must be an immutable sha256 digest reference."
  }
}

variable "container_port" {
  type        = number
  description = "Port the web app listens on inside the image; passed to the Lambda Web Adapter as AWS_LWA_PORT."

  validation {
    condition     = var.container_port >= 1 && var.container_port <= 65535 && floor(var.container_port) == var.container_port
    error_message = "container_port must be an integer from 1 through 65535."
  }
}

variable "memory_size" {
  type        = number
  description = "Lambda memory in MiB (CPU scales with memory)."
  default     = 512

  validation {
    condition     = contains([512, 1024, 2048], var.memory_size)
    error_message = "P1 supports the profile sizes 512, 1024, and 2048 MiB."
  }
}

variable "timeout" {
  type        = number
  description = "Lambda timeout in seconds for one HTTP request."
  default     = 30

  validation {
    condition     = var.timeout >= 1 && var.timeout <= 900 && floor(var.timeout) == var.timeout
    error_message = "timeout must be an integer from 1 through 900 seconds."
  }
}

variable "health_check_path" {
  type        = string
  description = "IR HTTP health check path; the Lambda Web Adapter waits for it before the first request (AWS_LWA_READINESS_CHECK_PATH)."
  default     = "/health"

  validation {
    condition     = startswith(var.health_check_path, "/") && !strcontains(var.health_check_path, " ")
    error_message = "health_check_path must be an absolute HTTP path."
  }
}

variable "public_ingress" {
  type        = bool
  description = "Whether the function is exposed through the public ALB origin. This profile only supports public HTTP apps."
  default     = true

  validation {
    condition     = var.public_ingress
    error_message = "aws-lambda-basic only supports public HTTP services."
  }
}

variable "environment_variables" {
  type        = map(string)
  description = "Non-sensitive project environment values. Names reserved by Lambda (AWS_REGION etc.) are dropped because Lambda sets them itself."
  default     = {}
}

variable "secret_references" {
  type        = map(string)
  description = "Kept for the provision contract shared with aws-ecs-basic. Secret delivery to Lambda is not implemented, so it must be empty."
  default     = {}

  validation {
    condition     = length(var.secret_references) == 0
    error_message = "aws-lambda-basic does not deliver secrets yet."
  }
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR of the two-AZ public VPC that hosts only the ALB (same as aws-ecs-basic)."
  default     = "10.42.0.0/16"
}
