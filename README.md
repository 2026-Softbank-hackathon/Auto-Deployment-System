# 🌸 Auto Deployment System

> **One Action, Infinite Clouds.** 로컬 웹앱 소스를 올리면 AI 가 분석해 IR(앱 명세) 로 만들고, 같은 이미지로 **AWS · 온프레미스에 원클릭 배포**한다. 환경 전환은 Cloudflare DNS CNAME 레벨 1 API call.

**SoftBank Hackathon 2026 · [Team camellia](https://github.com/2026-Softbank-hackathon)**

- 🌐 데모: https://console.camellia-deploy.app
- 📓 노션: https://www.notion.so/term1_team_camellia-6958bee9ada483d1815c01c831afcb3a

---

## 🏗 아키텍처

### 전체 (v5.5)
![전체 아키텍처](https://raw.githubusercontent.com/2026-Softbank-hackathon/Auto-Deployment-System/main/docs/architecture_overall_v5.5.svg)

### 상세 다이어그램
| 다이어그램 | 설명 |
|---|---|
| [AWS 배포](https://raw.githubusercontent.com/2026-Softbank-hackathon/Auto-Deployment-System/main/docs/architecture_deploy_aws_v5.5.svg) | Terraform S3 state · ECS/Lambda/S3 분기 · 워커 직접 롤아웃 체크 |
| [온프레미스 배포](https://raw.githubusercontent.com/2026-Softbank-hackathon/Auto-Deployment-System/main/docs/architecture_deploy_onprem_v5.5.svg) | Agent v0.1.8 · launchd · 롱폴링 · Named Tunnel · docker compose |
| [환경 전환](https://raw.githubusercontent.com/2026-Softbank-hackathon/Auto-Deployment-System/main/docs/architecture_env_switch_v5.5.svg) | CF DNS CNAME · TTL=1s · 15분 롤백 유예 · 대안 비교 |

---

## 💡 와우 포인트

1. **원클릭 배포** — 소스 zip → AI 분석 → 1회 빌드 → 두 환경 동시 배포
2. **환경 전환** — AWS ↔ 온프레미스를 CF DNS CNAME 1 API call 로 즉시 전환 (TTL=1s)
3. **같은 digest** — ECS · Lambda · S3 Static · 온프레미스 Docker 모두 하나의 이미지
4. **운영 가시화** — `/ops` 대시보드 (큐 · 워커 heartbeat · AI 비용 · CD 기록)
5. **다국어 콘솔** — AI 설명 1회 호출로 한국어·일본어 구조화 출력

---

## 📊 심사 제출 자료 (10/3 10:00)

### 1️⃣ 소스 코드
- 이 리포지토리: https://github.com/2026-Softbank-hackathon/Auto-Deployment-System
- 조직: https://github.com/2026-Softbank-hackathon

### 2️⃣ 설계 문서 · 논의 메모 (논의 과정 포함)
- **[📜 Discussion Log](https://www.notion.so/3ed8bee9ada481c48f49dfa1fc6944e1)** — 일자별 논의 과정 (9/27 ~ 10/3)
  - Day 1: 디자인 시스템 · 와이어 · 와우 포인트
  - Day 2: PoC · 아키텍처 트레이드오프 (IR+Terraform vs Dockerfile+Metadata)
  - Day 3: 절충안 v5.4.1 · Fastify+Zod · 역할 분담
  - Day 4: CF DNS CNAME 환경 전환 · EC2+Compose · Agent PR #97
  - Day 5: UX 재설계 · SSL Flexible · Agent v0.1.0→v0.1.8 · 다중 배포 유형
  - Day 6: /ops · 다국어 · subdomain · k6 · 중간발표 완성도
- **[📋 기능 명세 최신본](https://www.notion.so/3ed8bee9ada48055bbc1eba70915a0af)** — 109개 완료 기능
- **[🔌 API 명세 최신본](https://www.notion.so/3ed8bee9ada480e184aac51b6ac56213)** — 49개 완료 라우트
- **[docs/decisions.md](docs/decisions.md)** — 결정 기록 D-01 ~ D-69 (대안 · 선택 사유)

### 3️⃣ 발표 자료
- 중간발표 (10/3): *(링크 추가 예정)*
- 최종발표 (10/4): 미작성

---

## 🧱 기술 스택

| 영역 | 기술 |
|---|---|
| 백엔드 | TypeScript · Fastify 5 · Zod · pg-boss · PostgreSQL |
| 프론트 | React · SSE EventSource |
| 인프라 | Terraform (S3 backend + use_lockfile) · AWS (ECS · Lambda · S3) · Cloudflare (DNS · Named Tunnel) |
| Agent | Node.js (launchd 등록) · Docker Compose · cloudflared |
| AI | Anthropic Claude Sonnet 4.6 (구조화 출력) |
| 호스팅 | EC2 + Docker Compose + Cloudflare Tunnel |

---

## 🚀 로컬 실행

```bash
# 1. 의존성
pnpm install

# 2. DB
docker compose -f infra/dev/compose.yml up -d postgres

# 3. 마이그레이션
pnpm --filter @camellia/db migrate

# 4. API + Worker + Web
pnpm dev

# API: http://localhost:3000
# Web: http://localhost:5173
# OpenAPI: http://localhost:3000/docs
```

### 샘플 앱 배포
```bash
cd apps/samples/monolith
zip -r /tmp/sample.zip .
curl -F "source=@/tmp/sample.zip" -F "projectId=1" -F "targetEnvironment=aws" \
  http://localhost:3000/api/v1/deployments
```

---

## 📂 리포 구조

```
Auto-Deployment-System/
├── apps/
│   ├── api/              # Fastify + Zod + pg-boss (단일 프로세스: API + 오케스트레이터)
│   ├── worker/           # analyze · build · provision · verify · diagnose · address-change
│   ├── web/              # React 콘솔
│   ├── onprem-agent/     # v0.1.8 launchd Agent
│   └── samples/          # monolith, msa, sqlite-web, static-site
├── packages/
│   ├── analyzer/         # 언어 감지 · IR 빌더 · 위험 진단
│   ├── ir-schema/        # Zod IR 스키마
│   ├── cloudflare/       # DNS · Tunnel API 클라이언트
│   └── db/               # PostgreSQL 마이그레이션
├── infra/
│   ├── terraform/profiles/
│   │   ├── aws-ecs-basic/
│   │   ├── aws-lambda-basic/     # D-63 Lambda Web Adapter
│   │   ├── aws-static-basic/     # D-65 S3 정적 사이트
│   │   └── onprem-docker-basic/
│   └── platform/terraform/       # 플랫폼 자체 EC2+Compose
└── docs/
    ├── architecture_*_v5.5.svg   # 4종 다이어그램
    ├── decisions.md              # D-01 ~ D-69
    └── api명세-기능명세/*.csv
```

---

## 👥 팀 · 역할

| 역할 | 담당 | GitHub |
|---|---|---|
| PM · 분석 · IR · 발표 | 이정 | [@Pionia5375](https://github.com/Pionia5375) |
| 운영 대시보드 · CD · 로깅 | 조서현 | [@csh1668](https://github.com/csh1668) |
| 보안 · 비용 청구 | 안우진 | [@awj1052](https://github.com/awj1052) |
| 빌드 · 프로비저닝 · Terraform | 신은영 | [@gpffh20](https://github.com/gpffh20) |
| 프론트엔드 | 김민성 | [@minseong99](https://github.com/minseong99) |
| 검증 · Agent · 헬스체크 | 김민서 | [@kmsdevdata-sketch](https://github.com/kmsdevdata-sketch) |

---

**심사 기준 가중치**: 완성도·데모 30 / 클라우드 활용 30 / 팀 개발 20 / 독창성 10 / AI 10
