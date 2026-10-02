# 정적 사이트 (#274): 서버 없이 S3 웹사이트 호스팅. Cloudflare 가 공개 주소(HTTPS)를 받아
# 이 버킷의 웹사이트 endpoint(HTTP)로 프록시한다. 파일은 worker 가 빌드한 이미지에서 꺼내 동기화한다.

resource "aws_s3_bucket" "site" {
  bucket = var.bucket_name
  # 앱 삭제 · 프로필 전환 때 파일이 남아 있어도 버킷을 지울 수 있게
  force_destroy = true

  tags = {
    Name = var.app_name
  }
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# ACL 로 공개하는 길은 막고, 읽기는 아래 버킷 정책(출발지 IP 제한)으로만 연다
resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  index_document {
    suffix = "index.html"
  }

  # SPA: 없는 경로도 index.html 을 돌려준다 (S3 는 이때 상태 코드 404 를 그대로 둔다)
  error_document {
    key = var.spa_fallback ? "index.html" : "404.html"
  }
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "ReadFromCloudflareAndVerifier"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "IpAddress"
      variable = "aws:SourceIp"
      values   = concat(var.cloudflare_ip_ranges, var.verifier_cidrs)
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}
