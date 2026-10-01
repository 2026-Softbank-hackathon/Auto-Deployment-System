# 플랫폼 전용 최소 VPC: 퍼블릭 서브넷 1개 + IGW. NAT Gateway 없음(비용 0).
# 인바운드는 전혀 열지 않는다 — 외부 접속은 Cloudflare Tunnel(아웃바운드 연결)로만 들어온다.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "platform" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "platform" {
  vpc_id = aws_vpc.platform.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.platform.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.platform.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.platform.id
  }

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "host" {
  name        = "${var.name_prefix}-host"
  description = "Camellia platform host - no inbound, all outbound"
  vpc_id      = aws_vpc.platform.id

  tags = {
    Name = "${var.name_prefix}-host"
  }
}

# 아웃바운드: GitHub clone · 이미지 pull · 사용자 ECR push · AWS/Cloudflare/Anthropic API · Tunnel
resource "aws_vpc_security_group_egress_rule" "all_ipv4" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "All outbound"
}
