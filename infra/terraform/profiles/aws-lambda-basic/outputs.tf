output "origin_url" {
  description = "HTTP origin endpoint (ALB) for Cloudflare routing and direct pre-switch verification."
  value       = var.public_ingress ? "http://${aws_lb.app[0].dns_name}" : null
}

output "origin_hostname" {
  description = "AWS ALB DNS hostname used as a CNAME target."
  value       = var.public_ingress ? aws_lb.app[0].dns_name : null
}

output "function_name" {
  value = aws_lambda_function.app.function_name
}

output "function_alias" {
  description = "Alias the ALB invokes; it points to the version published for this image."
  value       = aws_lambda_alias.live.name
}

output "function_version" {
  value = aws_lambda_function.app.version
}
