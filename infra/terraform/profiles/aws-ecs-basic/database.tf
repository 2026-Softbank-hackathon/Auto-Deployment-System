# PostgreSQL 추가 모듈 (#278) — IR 에 postgres 리소스가 있을 때만 만든다 (database_enabled).
# 골격의 VPC 안에 인터넷 경로가 없는 private subnet 2개를 더하고, ECS 서비스 보안 그룹에서만 5432 로 접속을 받는다.
# 마스터 비밀번호는 RDS 가 Secrets Manager 에 만들고 관리한다(manage_master_user_password) — Terraform 변수 · state 에 남지 않는다.
# 앱에는 비밀번호 없는 DATABASE_URL(일반 환경변수)과 PGPASSWORD(시크릿)를 넣는다. libpq · node-postgres 는 둘을 합쳐 접속한다.

locals {
  database_count    = var.database_enabled ? 1 : 0
  database_name     = "app"
  database_username = "camellia"
  # RDS 식별자 · 서브넷 그룹 · 파라미터 그룹 이름은 소문자만 받는다
  database_identifier = "${lower(var.resource_name)}-db"

  database_environment = var.database_enabled ? {
    (var.database_env_name) = "postgresql://${local.database_username}@${aws_db_instance.database[0].address}:${aws_db_instance.database[0].port}/${local.database_name}"
  } : {}
  database_secrets = var.database_enabled ? {
    PGPASSWORD = "${aws_db_instance.database[0].master_user_secret[0].secret_arn}:password::"
  } : {}
  database_secret_arns = var.database_enabled ? [aws_db_instance.database[0].master_user_secret[0].secret_arn] : []
}

resource "aws_subnet" "private" {
  count = var.database_enabled ? 2 : 0

  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index + 101)
  map_public_ip_on_launch = false

  tags = merge(local.tags, { Name = "${var.resource_name}-private-${count.index + 1}" })
}

# 경로를 따로 두지 않는다 — VPC 안(local)으로만 통한다
resource "aws_route_table" "private" {
  count = local.database_count

  vpc_id = aws_vpc.main.id

  tags = merge(local.tags, { Name = "${var.resource_name}-private" })
}

resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

resource "aws_db_subnet_group" "database" {
  count = local.database_count

  name       = local.database_identifier
  subnet_ids = aws_subnet.private[*].id

  tags = local.tags
}

resource "aws_security_group" "database" {
  count = local.database_count

  name_prefix = "${var.resource_name}-db-"
  description = "PostgreSQL only from the Camellia ECS service."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from the ECS service"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.service.id]
  }

  tags = merge(local.tags, { Name = "${var.resource_name}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

# PostgreSQL 15+ 의 RDS 기본값은 TLS 강제(rds.force_ssl=1)다. Node 기본 CA 에 RDS CA 가 없어 앱마다 인증서 설정이 필요해지므로,
# private subnet + 보안 그룹으로 막힌 이 DB 는 평문 접속도 받는다 (저장 데이터는 암호화).
resource "aws_db_parameter_group" "database" {
  count = local.database_count

  name_prefix = "${local.database_identifier}-pg16-"
  family      = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "0"
  }

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "database" {
  count = local.database_count

  identifier     = local.database_identifier
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name                     = local.database_name
  username                    = local.database_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.database[0].name
  vpc_security_group_ids = [aws_security_group.database[0].id]
  parameter_group_name   = aws_db_parameter_group.database[0].name
  publicly_accessible    = false
  multi_az               = false

  # 해커톤 비용 · 생성 시간 우선: 자동 백업 없음, 앱 삭제 때 스냅샷 없이 지운다
  backup_retention_period    = 0
  skip_final_snapshot        = true
  deletion_protection        = false
  apply_immediately          = true
  auto_minor_version_upgrade = true

  tags = merge(local.tags, { Name = local.database_identifier })
}
