output "origin_url" {
  description = "S3 website endpoint (HTTP) for direct pre-switch verification."
  value       = "http://${aws_s3_bucket_website_configuration.site.website_endpoint}"
}

output "origin_hostname" {
  description = "S3 website endpoint hostname used as the Cloudflare proxied CNAME target."
  value       = aws_s3_bucket_website_configuration.site.website_endpoint
}

output "bucket_name" {
  description = "Bucket the worker syncs the built files into."
  value       = aws_s3_bucket.site.bucket
}
