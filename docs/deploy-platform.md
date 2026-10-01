# 플랫폼 AWS 배포 — EC2 + Docker Compose + Cloudflare Tunnel

배포 시스템 **자체**(web · api · worker · Postgres)를 AWS에 올리는 방법. 사용자 앱 배포(`infra/terraform/profiles/*`)와는 별개다.

- 주소: **https://console.camellia-deploy.app** (Terraform 변수 `console_subdomain`)
- 사용자 앱 주소 `service-{projectId}.apps.camellia-deploy.app` 과 겹치지 않는다
- 관련 파일: `apps/{api,worker,web}/Dockerfile`, `apps/web/nginx/`, `infra/platform/`

## 1. 구조

```
 브라우저 / 심사위원                     On-Prem Agent (Intel Mac VM)
        │ HTTPS                                │ HTTPS (Bearer agent key)
        ▼                                      ▼
 ┌──────────────── Cloudflare (camellia-deploy.app) ────────────────┐
 │  console.camellia-deploy.app  ── proxied CNAME ──▶ Named Tunnel   │
 └───────────────────────────────────────────┬──────────────────────┘
                                             │ 아웃바운드 연결만 (인바운드 포트 0개)
 ┌─ AWS ap-northeast-2 · 전용 VPC · 퍼블릭 서브넷 · SG 인바운드 없음 ─────────────────┐
 │  EC2 t3.large (Ubuntu 24.04, gp3 40GB 암호화, IMDSv2, SSM Session Manager)          │
 │  ┌─ docker compose (infra/platform/compose.yaml) ───────────────────────────────┐   │
 │  │ cloudflared ──edge──▶ web (nginx :8080)                                       │   │
 │  │                        ├ 정적 SPA (Vite build)                                │   │
 │  │                        ├ Basic Auth → X-API-Key 주입 → /api/ · /docs          │   │
 │  │                        └ SSE 버퍼링 off, 타임아웃 1h                           │   │
 │  │                 ──backend──▶ api (Fastify :3000) ──┐                          │   │
 │  │                              worker (pg-boss) ─────┼──▶ postgres (볼륨 pgdata) │   │
 │  │                              │  ▲ migrate(1회) ────┘                          │   │
 │  │      volume storage ◀────────┴──┘ (업로드 소스 · 로그, api 와 공유)            │   │
 │  │                              │ ──build──▶ buildkit (railpack 전용)            │   │
 │  └──────────────────────────────┼────────────────────────────────────────────────┘   │
 │        /var/run/docker.sock ◀───┘ (Buildx 빌드 → 사용자 ECR push)                     │
 └──────────────────────────────────────────────────────────────────────────────────────┘
          │ worker 아웃바운드: 사용자 AWS(ECR · Terraform · S3 state), Cloudflare API, Anthropic
```

시크릿 흐름: **SSM Parameter Store(SecureString)** → 부팅 · 갱신 때 `deploy.sh` 가 읽어 `infra/platform/.env`(root, 600) 생성 → compose 가 서비스별로 필요한 값만 넘긴다. git · Terraform 변수에는 비밀을 두지 않는다. 예외는 Terraform 이 직접 만드는 Tunnel token 하나(state 에 남음).

## 2. 왜 이렇게 했나

| 결정 | 버린 대안 | 이유 |
|---|---|---|
| **EC2 한 대 + Docker Compose** | ECS Fargate (D-53) | worker 가 사용자 앱을 `docker buildx` 로 빌드하고 Terraform CLI 를 실행한다. Fargate 에는 Docker 데몬이 없어 빌드를 못 한다 (원격 BuildKit · CodeBuild 를 붙이면 구조가 커진다). D-53 의 요지(Lambda 가 아닌 상시 실행 애플리케이션)는 그대로이고, 호스트만 EC2 로 바꾼다 → D-54 |
| **Cloudflare Tunnel** (`cloudflared` 컨테이너) | Elastic IP + A 레코드, ALB + ACM | 인바운드 포트를 하나도 열지 않는다. HTTPS 인증서 자동. EIP · ALB 비용 없음. 팀 도메인이 이미 Cloudflare 에 있고 사용자 앱도 같은 Named Tunnel 방식(packages/cloudflare)을 쓴다 |
| **Postgres 컨테이너** (EBS 볼륨) | RDS | 해커톤 4일 · 단일 호스트에는 충분. RDS 는 서브넷 2개 · 비용 · 생성 시간이 추가된다. 대신 백업은 수동 (7절) |
| **호스트에서 git clone 후 빌드** | 이미지를 ECR 에 push 후 pull | 리포가 public 이라 자격증명이 필요 없다. 플랫폼용 ECR · 빌드 파이프라인이 필요 없다. 갱신 = `deploy.sh <ref>` 한 줄 |
| **전용 최소 VPC** (퍼블릭 서브넷 1개, NAT 없음) | default VPC | 계정에 default VPC 가 없어도 동작, `terraform destroy` 로 깔끔히 정리, 사용자 앱 리소스와 분리. 비용 0 |
| **nginx Basic Auth + API Key 주입** | 웹이 세션 토큰을 붙이도록 앱 수정, Cloudflare Access | production API 는 API_KEY 필수(PR #64)인데 웹(fetch · EventSource)은 인증 헤더를 붙이지 않는다. EventSource 는 헤더를 못 붙인다. 앱 코드를 고치지 않고 프록시에서 해결한다 |
| **tsx 로 TypeScript 직접 실행** | tsc 빌드 후 `node dist` | workspace 패키지들이 `src/*.ts` 를 export 해서 컴파일 산출물이 없다. dev 와 같은 실행 경로라 검증된 경로를 그대로 쓴다 |

### 콘솔 인증 규칙 (nginx)

| 요청 | Basic Auth | API 로 넘기는 인증 |
|---|---|---|
| 브라우저 (콘솔 · Swagger) | 필요 | nginx 가 `X-API-Key: <API_KEY>` 주입, Basic 헤더는 제거 |
| `Authorization: Bearer ...` (Agent heartbeat · job claim, CLI) | 건너뜀 | Bearer 그대로 → API 가 검증 (API Key · 세션 토큰 · Agent key) |
| `POST /api/v1/agents/register` | 건너뜀 | 본문의 1회용 등록 토큰 → API 가 검증 |
| `GET /health` | 건너뜀 | 없음 (API 도 인증 제외) |

On-Prem Agent 는 `ONPREM_CONTROL_PLANE_URL=https://console.camellia-deploy.app` 로 설정하면 된다.

## 3. 파일

| 파일 | 내용 |
|---|---|
| `.dockerignore` | 빌드 컨텍스트(리포 루트)에서 node_modules · 문서 · 테스트 · 시크릿 제외 |
| `apps/api/Dockerfile` | `pnpm fetch` → `install --prod --filter @camellia/api...` → node:22-alpine + tsx, non-root. migrate 도 이 이미지 |
| `apps/worker/Dockerfile` | 위와 같음 + docker CLI · buildx · git · terraform(SHA256 검증) · railpack |
| `apps/web/Dockerfile` | Vite 빌드 → nginx-unprivileged(:8080, non-root) |
| `apps/web/nginx/` | `default.conf.template`(envsubst), `api-proxy.conf`, `12-camellia-auth.envsh`(Basic Auth, fail-closed) |
| `infra/platform/compose.yaml` | 운영 스택. `cloudflared` 는 `tunnel` 프로필 |
| `infra/platform/compose.local.yaml` | 로컬 검증용: web 을 `127.0.0.1:8080` 에 publish |
| `infra/platform/platform.env.example` | `.env` 항목 전체 |
| `infra/platform/scripts/deploy.sh` | 호스트에서 git checkout → SSM → `.env` → `compose up --build` |
| `infra/platform/terraform/` | VPC · SG · IAM · EC2 · Cloudflare Tunnel · DNS · SSM(Tunnel token), `tests/` mock plan 테스트 |

## 4. 배포 런북

### 4.0 준비물

- AWS 자격증명 (EC2 · VPC · IAM · SSM 생성 권한), AWS CLI
- Terraform ≥ 1.10 (없으면 `docker run --rm -v "$PWD:/w" -w /w hashicorp/terraform:1.16.4 ...`)
- Cloudflare API token — **Account › Cloudflare Tunnel: Edit**, **Zone › DNS: Edit** (camellia-deploy.app). 사용자 앱용 토큰과 같은 권한이다. 토큰은 파일에 쓰지 말고 환경변수로만
- Cloudflare account ID · zone ID
- Windows Git Bash 에서는 `/camellia/...` 경로가 변환되지 않도록 `export MSYS_NO_PATHCONV=1`

### 4.1 SSM 파라미터 등록 (최초 1회)

경로 `/camellia/platform/env/<ENV 이름>` 아래의 값이 그대로 `.env` 가 된다. 값에 따옴표 · 공백 · `$` 를 넣지 않는다.

```bash
export AWS_REGION=ap-northeast-2
P=/camellia/platform/env

# 필수 (비밀)
aws ssm put-parameter --name $P/POSTGRES_PASSWORD           --type SecureString --value "$(openssl rand -hex 24)"
aws ssm put-parameter --name $P/API_KEY                     --type SecureString --value "$(openssl rand -hex 32)"
aws ssm put-parameter --name $P/SECRET_MASTER_KEY           --type SecureString --value "$(openssl rand -base64 32)"
aws ssm put-parameter --name $P/CONSOLE_BASIC_AUTH_PASSWORD --type SecureString --value "<팀 공유 콘솔 비밀번호>"

# 선택
aws ssm put-parameter --name $P/DEMO_PLATFORM_DOMAIN  --type String       --value camellia-deploy.app
aws ssm put-parameter --name $P/CLOUDFLARE_API_TOKEN  --type SecureString --value "<사용자 앱 DNS · Tunnel 관리용 토큰>"
aws ssm put-parameter --name $P/CLOUDFLARE_ZONE_ID    --type String       --value "<zone ID>"
aws ssm put-parameter --name $P/CLOUDFLARE_ACCOUNT_ID --type String       --value "<account ID>"
aws ssm put-parameter --name $P/ANTHROPIC_API_KEY     --type SecureString --value "<키>"          # AI 보완 · 진단
aws ssm put-parameter --name $P/TERRAFORM_STATE_BUCKET     --type String --value "<bucket>"     # 셋 다 넣거나
aws ssm put-parameter --name $P/TERRAFORM_STATE_REGION     --type String --value ap-northeast-2 # 셋 다 빼기
aws ssm put-parameter --name $P/TERRAFORM_STATE_KMS_KEY_ID --type String --value "<kms arn>"
# CONSOLE_BASIC_AUTH_USER (기본 camellia), LOG_LEVEL, VITE_DEMO_TARGET 도 같은 방식
```

- `SECRET_MASTER_KEY` 는 첫 배포 후 바꾸면 저장된 시크릿을 복호화할 수 없다
- `CLOUDFLARE_TUNNEL_TOKEN` 은 Terraform 이 넣는다 (직접 넣지 않기)
- 콘솔 계정: 사용자 `camellia` / 비밀번호 = `CONSOLE_BASIC_AUTH_PASSWORD`

### 4.2 Terraform apply

```bash
cd infra/platform/terraform
cp terraform.tfvars.example terraform.tfvars      # account ID · zone ID 입력
export CLOUDFLARE_API_TOKEN=...                   # 셸에서만
# (팀 공유 state) cp backend.tf.example backend.tf 후 bucket 입력
terraform init
terraform plan
terraform apply
terraform output                                  # console_url, instance_id, ssm_session_command
```

### 4.3 첫 부팅

EC2 user-data 가 Docker 설치 → 리포 clone → `deploy.sh main` 실행. 이미지 빌드까지 **약 5~10분**.

```bash
aws ssm start-session --target <instance_id>
sudo tail -f /var/log/camellia-bootstrap.log
sudo docker compose -f /opt/camellia/platform/infra/platform/compose.yaml --profile tunnel ps
```

확인:

```bash
curl -s https://console.camellia-deploy.app/health                      # {"status":"ok"}
curl -s -u camellia:<비밀번호> https://console.camellia-deploy.app/api/v1/projects
```

SSM 값이 빠져 실패했다면 값을 넣고 4.4 로 다시 실행하면 된다.

### 4.4 갱신 · 재배포

브랜치 · 태그 · 커밋을 지정한다 (기본 `main`). 이미지를 다시 빌드하고 바뀐 컨테이너만 재생성한다. 마이그레이션은 매번 실행되고 이미 적용된 것은 건너뛴다.

```bash
# 셸 없이 한 줄로
aws ssm send-command --instance-ids <instance_id> --document-name AWS-RunShellScript \
  --parameters 'commands=["bash /opt/camellia/platform/infra/platform/scripts/deploy.sh main"],executionTimeout=["1800"]' \
  --query Command.CommandId --output text
aws ssm get-command-invocation --instance-id <instance_id> --command-id <CommandId> --query '[Status,StandardOutputContent]'

# 또는 세션에서
sudo bash /opt/camellia/platform/infra/platform/scripts/deploy.sh seohyun/feat#110
```

SSM 값만 바꾼 경우에도 같은 명령이다 (`.env` 를 다시 만든다).

### 4.5 로그

```bash
aws ssm start-session --target <instance_id>
cd /opt/camellia/platform/infra/platform
sudo docker compose --profile tunnel logs -f --tail 200 api worker
sudo docker compose --profile tunnel logs --tail 100 web cloudflared
```

로그는 컨테이너당 10MB × 5개로 순환된다.

### 4.6 삭제

```bash
# (권장) DB 백업 먼저 — 7절
cd infra/platform/terraform && terraform destroy
# Terraform 밖에서 만든 SSM 값 정리
aws ssm get-parameters-by-path --path /camellia/platform/env --query 'Parameters[].Name' --output text \
  | xargs -n 10 aws ssm delete-parameters --names
```

인스턴스와 EBS 가 지워지므로 Postgres 데이터도 사라진다.

## 5. 로컬에서 같은 스택 검증

```bash
cd infra/platform
cp platform.env.example .env       # 필수 4개를 openssl 로 채움 (CLOUDFLARE_TUNNEL_TOKEN 은 비움)
# Docker Desktop: docker.sock 그룹이 root(0) 라 DOCKER_GID 는 기본값 0 으로 충분
docker compose -f compose.yaml -f compose.local.yaml up -d --build
curl -s http://127.0.0.1:8080/health
curl -s -u camellia:<비밀번호> http://127.0.0.1:8080/api/v1/projects
docker compose -f compose.yaml -f compose.local.yaml down -v   # 정리 (볼륨 포함)
```

## 6. 비용 (ap-northeast-2 온디맨드, 대략)

| 항목 | 단가 | 하루 |
|---|---|---|
| EC2 t3.large | $0.104/h | $2.50 |
| EBS gp3 40GB | $0.0912/GB-월 | $0.12 |
| 퍼블릭 IPv4 1개 | $0.005/h | $0.12 |
| SSM Parameter Store(표준) · Session Manager · Cloudflare Tunnel | 무료 | 0 |
| **합계** | | **약 $2.75 (≈ ₩3,900)** |

해커톤 5일 ≈ $14 (≈ ₩19,000). `instance_type = "t3.medium"` 이면 하루 약 $1.5. 데이터 전송은 월 100GB 까지 무료 범위. t3 는 기본 unlimited 크레딧이라 빌드가 길게 이어지면 소폭 추가될 수 있다. 사용자 앱(ECS · ALB 등)은 사용자 계정 비용으로 별도.

## 7. 한계 · 리스크

- **단일 호스트**: 인스턴스 장애 = 플랫폼 중단. 재부팅은 `restart: unless-stopped` 로 자동 복구
- **DB 백업 수동**: 데모 전후로 받아 두기
  ```bash
  sudo docker compose -f /opt/camellia/platform/infra/platform/compose.yaml exec -T postgres \
    pg_dump -U camellia camellia | gzip > /opt/camellia/backup-$(date +%F-%H%M).sql.gz
  ```
  필요하면 EBS 스냅샷(`aws ec2 create-snapshot`)도 가능
- **docker.sock = 호스트 root 권한**: worker 가 뚫리면 호스트도 뚫린다. worker 는 non-root 지만 docker 그룹이 붙는다. buildkit 은 privileged. 둘 다 외부에 포트가 없고 buildkit 은 worker 만 붙는 `build` 네트워크에만 있다
- **콘솔 = API 전체 권한**: Basic Auth 를 통과하면 nginx 가 API Key 를 붙인다. 콘솔 비밀번호를 API Key 처럼 다룬다. 노출되면 SSM 값을 바꾸고 4.4 실행
- **IMDS 차단**: hop limit 1 이라 컨테이너는 인스턴스 역할 자격증명을 못 얻는다(의도). worker 는 사용자 등록 AWS 키만 쓴다
- **업로드 100MB**: Cloudflare 무료 플랜 요청 본문 한도가 100MB, API 한도도 100MB
- **Tunnel token 이 state 에 있음**: S3 backend 를 쓸 때 암호화 · 접근 제한 bucket 사용
- **AMI · user-data 변경은 무시**(`ignore_changes`): 인스턴스를 의도치 않게 갈아엎지 않기 위함. OS 를 새로 받으려면 `terraform apply -replace=aws_instance.host` (DB 백업 후)
- **같은 호스트에서 빌드**: 플랫폼 갱신 빌드와 사용자 앱 빌드가 CPU · 메모리를 나눠 쓴다. 2GiB swap 추가. 오래된 이미지 · 빌드 캐시는 매일 정리(72h 초과)
- **감사 로그 IP**: API 가 `trustProxy` 를 켜지 않아 요청 IP 가 nginx 컨테이너 IP 로 기록된다 (앱 변경 범위 밖)
- 실제 AWS · Cloudflare 에는 아직 apply 해 보지 않았다. 로컬 compose 검증 + `terraform validate` · mock `terraform test` 까지만 했다
