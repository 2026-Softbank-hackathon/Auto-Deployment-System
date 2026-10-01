# 플랫폼 콘솔용 Cloudflare Named Tunnel. packages/cloudflare 와 같은 방식
# (config_src = cloudflare 원격 설정, <tunnel-id>.cfargotunnel.com 으로 proxied CNAME).
# 사용자 앱 영역(service-*.<도메인>)과는 별개의 Tunnel · 호스트명이다.

locals {
  console_hostname = "${var.console_subdomain}.${var.platform_domain}"
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "console" {
  account_id = var.cloudflare_account_id
  name       = "${var.name_prefix}-console"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "console" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.console.id

  config = {
    ingress = [
      {
        # compose 의 web(nginx) 서비스. cloudflared 와 같은 edge 네트워크에 있다
        hostname = local.console_hostname
        service  = "http://web:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_dns_record" "console" {
  zone_id = var.cloudflare_zone_id
  name    = local.console_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.console.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "Camellia platform console (Terraform infra/platform)"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "console" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.console.id
}

# cloudflared 가 쓰는 Tunnel token 을 SSM 에 넣는다 → deploy.sh 가 .env 로 가져간다.
# (token 은 state 에도 남는다. state 는 암호화된 S3 backend 에 두는 것을 권장)
resource "aws_ssm_parameter" "tunnel_token" {
  name  = "${var.ssm_parameter_prefix}/CLOUDFLARE_TUNNEL_TOKEN"
  type  = "SecureString"
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.console.token
}
