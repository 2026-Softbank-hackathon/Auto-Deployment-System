# 팀 공유 state: S3 + use_lockfile(DynamoDB 없이 S3 잠금 파일 <key>.tflock).
# bucket 은 버전 관리 · SSE-S3 · 퍼블릭 차단. state 에 Tunnel token 이 있으므로 접근은 IAM 으로 제한한다.
# 바꾸면 github-terraform.tf 의 tf_state_bucket · tf_state_key 기본값도 같이 바꾼다 (CI 역할 권한 범위).
terraform {
  backend "s3" {
    bucket       = "camellia-tfstate-725072160743"
    key          = "camellia/platform/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
