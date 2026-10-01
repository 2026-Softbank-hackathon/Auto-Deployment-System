output "console_url" {
  description = "플랫폼 콘솔 주소"
  value       = "https://${local.console_hostname}"
}

output "instance_id" {
  description = "플랫폼 EC2 인스턴스 ID"
  value       = aws_instance.host.id
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID"
  value       = cloudflare_zero_trust_tunnel_cloudflared.console.id
}

output "ssm_session_command" {
  description = "호스트 셸 접속 (SSH 키 없음)"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.host.id}"
}

output "ssm_parameter_prefix" {
  description = "플랫폼 env 를 넣을 SSM 경로"
  value       = var.ssm_parameter_prefix
}

output "github_cd_role_arn" {
  description = "GitHub Actions CD 역할 ARN → 저장소 변수 AWS_CD_ROLE_ARN"
  value       = aws_iam_role.github_cd.arn
}
