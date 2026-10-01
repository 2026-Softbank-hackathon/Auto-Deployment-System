output "origin_url" {
  description = "HTTP origin endpoint for Cloudflare routing and direct pre-switch verification."
  value       = var.public_ingress ? "http://${aws_lb.app[0].dns_name}" : null
}

output "origin_hostname" {
  description = "AWS ALB DNS hostname used as a CNAME target."
  value       = var.public_ingress ? aws_lb.app[0].dns_name : null
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.app.arn
}
