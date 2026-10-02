mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  app_name       = "landing"
  region         = "ap-northeast-2"
  bucket_name    = "service-12.camellia.example.com"
  verifier_cidrs = ["203.0.113.10/32"]
}

run "plans_s3_website_named_after_public_hostname" {
  command = plan

  assert {
    condition     = aws_s3_bucket.site.bucket == "service-12.camellia.example.com"
    error_message = "The bucket must be named exactly like the public hostname Cloudflare proxies."
  }

  assert {
    condition     = aws_s3_bucket.site.force_destroy
    error_message = "App delete and profile switches must be able to remove a non-empty bucket."
  }

  assert {
    condition     = aws_s3_bucket_website_configuration.site.index_document[0].suffix == "index.html"
    error_message = "The website must serve index.html."
  }

  assert {
    condition     = aws_s3_bucket_website_configuration.site.error_document[0].key == "index.html"
    error_message = "SPA fallback must serve index.html for unknown paths."
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.site.block_public_acls &&
      aws_s3_bucket_public_access_block.site.ignore_public_acls
    )
    error_message = "Public ACLs must stay blocked; reads are opened only by the IP-restricted bucket policy."
  }

  assert {
    condition = (
      contains(one(data.aws_iam_policy_document.site.statement[0].condition).values, "173.245.48.0/20") &&
      contains(one(data.aws_iam_policy_document.site.statement[0].condition).values, "203.0.113.10/32") &&
      one(data.aws_iam_policy_document.site.statement[0].condition).variable == "aws:SourceIp"
    )
    error_message = "Objects must be readable only from Cloudflare ranges and the platform verifier."
  }

  assert {
    condition     = data.aws_iam_policy_document.site.statement[0].actions == toset(["s3:GetObject"])
    error_message = "The bucket policy must only allow reading objects."
  }
}

run "uses_404_document_without_spa_fallback" {
  command = plan

  variables {
    spa_fallback = false
  }

  assert {
    condition     = aws_s3_bucket_website_configuration.site.error_document[0].key == "404.html"
    error_message = "Without SPA fallback unknown paths must use 404.html."
  }
}

run "rejects_invalid_bucket_name" {
  command = plan

  variables {
    bucket_name = "Service_12.Example.com"
  }

  expect_failures = [var.bucket_name]
}

run "rejects_invalid_verifier_cidr" {
  command = plan

  variables {
    verifier_cidrs = ["not-an-ip"]
  }

  expect_failures = [var.verifier_cidrs]
}
