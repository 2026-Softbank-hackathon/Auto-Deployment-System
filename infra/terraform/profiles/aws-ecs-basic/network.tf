data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  tags = {
    Application = var.app_name
    Environment = var.resource_name
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, { Name = "${var.resource_name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "${var.resource_name}-igw" })
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 1)
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Name = "${var.resource_name}-public-${count.index + 1}" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.tags, { Name = "${var.resource_name}-public" })
}

resource "aws_route_table_association" "public" {
  count = 2

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "service" {
  name_prefix = "${var.resource_name}-service-"
  description = "Allow application traffic only from the Camellia ALB."
  vpc_id      = aws_vpc.main.id

  dynamic "ingress" {
    for_each = var.public_ingress ? [1] : []
    content {
      description     = "Application traffic from ALB"
      protocol        = "tcp"
      from_port       = var.container_port
      to_port         = var.container_port
      security_groups = [aws_security_group.alb[0].id]
    }
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.resource_name}-service" })
}

resource "aws_security_group" "alb" {
  count = var.public_ingress ? 1 : 0

  name_prefix = "${var.resource_name}-alb-"
  description = "Public HTTP ingress proxied by the Cloudflare platform edge."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from Cloudflare and public clients"
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.resource_name}-alb" })
}
