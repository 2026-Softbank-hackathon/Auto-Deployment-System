# 설계 결정 기록 (ADR 초안)

> 2026-09-30 갱신: D-28~ 추가, 기존 결정 중 대체된 것은 아래 "대체된 결정"에 표시. 충돌 시 번호가 큰 쪽(최신)이 우선.
Notion ADR로 옮길 때 "배경 / 선택지 / 결정 / 이유 / 결과"를 채운다.

## 확정 (claude.ai 세션에서 합의)
| # | 결정 | 버린 대안 | 이유 |
|---|---|---|---|
| D-01 | 만드는 것은 **배포 시스템**(사용자 계정·서버에 배포), 호스팅 플랫폼 아님 | Vercel·Heroku형 자체 호스팅 | 공식 표현이 "배포할 수 있는 시스템/서비스", 멀티테넌시·과금 불필요 |
| D-02 | 컨트롤 플레인 / 데이터 플레인 분리 | 배포 도구를 앱 서버에 통합 | 장애 격리, 데이터 주권, 멀티 환경 확장 |
| D-03 | **IR(클라우드 중립 앱 명세, YAML)** 중심 + 프로바이더 어댑터 | 앱×환경 조합별 변환 | N+M 변환, 이식성 심사(30점) 대응, AI 출력을 스키마로 검증 가능 |
| D-04 | 클라우드 고유 기능은 IR `overrides` + 어댑터에서 수용 | 최소공통분모만 지원 | 심사 "고유 기능 대응" |
| D-05 | AI는 판단(분석·패치·진단·추천 설명)만, 실행은 검증된 IaC 템플릿 | LLM이 Terraform 즉석 생성 | 데모 안정성, 안전성, 토큰 비용(ROI) |
| D-06 | AI 에이전트 = API를 도구로 쓰는 클라이언트, `requires_approval` 도구는 API 서버가 강제 | 에이전트가 시스템 중심 | 가드레일을 코드로 보장 |
| D-07 | 사람 승인 게이트: 코드 수정, 환경 확정, 인프라 플랜, 운영 롤백 | 전자동 | 안전성·신뢰 |
| D-08 | 클라우드 자격증명: **역할 위임 + 단기 자격증명**(AWS AssumeRole, GCP SA 가장, Azure 워크로드 ID 페더레이션). 볼트에는 역할 식별자만 | 장기 액세스 키 보관 | 유출 피해 최소화 |
| D-09 | 온프레미스: **에이전트 Pull(롱 폴링)** + **1회용 등록 토큰**, 외부 노출 Cloudflare Tunnel | SSH Push | 방화벽/NAT 뒤 서버, 인바운드 포트 불필요 (SSH는 PoC 실패 시 대안) |
| D-10 | 실시간 로그는 **SSE** (Redis 이벤트 스트림 경유, Last-Event-ID 재연결) | 폴링, WebSocket | 단방향으로 충분, 자동 재연결, 무상태 API |
| D-11 | **작업 큐는 Postgres**(FOR UPDATE SKIP LOCKED + LISTEN/NOTIFY, pg-boss/River 등). Redis는 SSE·캐시만 | Redis(BullMQ), RabbitMQ, Kafka, SQS, Temporal | 상태 변경과 작업 생성을 한 트랜잭션(이중 쓰기 제거), 내구성, 인프라 추가 없음. Temporal은 P-05 실패 시 대안 |
| D-12 | Postgres 테이블별 **쓰기 소유 컴포넌트 1개** | 공유 DB 자유 쓰기 / 서비스별 DB | 상태 머신 우회 방지, 경쟁 조건 제거, 추후 분리 용이 |
| D-13 | 무상태 컴포넌트(API, 워커, 관측 게이트웨이)는 N대, 상태 결정(오케스트레이터)은 활성 1 + 대기 1 | 전부 다중 활성 | 락·상태 결정 충돌 방지 |
| D-14 | 락 두 겹: 오케스트레이터 **환경 락**(env_locks, 임대 만료·연장) + IaC state 잠금 | 한 겹 | 시스템 밖 IaC 실행도 방어 |
| D-15 | **환경 락 획득 시점 = 환경 확정 직후 (계획 전)**. 플랜은 반드시 락 안에서 | 접수 시점 획득 | 배포 생성 시 대상 환경 미정(추천 후 확정). ERD 검증에서 발견 |
| D-16 | 승인 대기 제한 시간(예: 30분) 초과 시 자동 취소 | 무기한 | 락 장기 점유 방지 |
| D-17 | 관측 게이트웨이 = **조회 대리**(데이터는 각 환경에), 카나리 핵심 지표만 요약 | 중앙 수집 | 데이터 경계(NFR-03), 저장 비용 |
| D-18 | 프로파일링은 전 환경 **Pyroscope** 통일 | 클라우드별 프로파일러 | AWS·Azure 공백 해소, 환경 차이 축소 |
| D-19 | 추천은 **규칙 엔진 + 가격 카탈로그**, AI는 근거 설명만 | LLM 추천 | 재현성, 비용 |
| D-20 | 데이터 경계: 런타임 데이터는 사용자 환경. 소스는 컨트롤 플레인 경유(계정 내 빌드 CodeBuild/Cloud Build/ACR Tasks로 전환 가능), LLM 전송 시 비밀값 마스킹 | 모든 데이터 사용자 환경 | 현실적 범위 |
| D-21 | 빌드는 샌드박스(루트리스 BuildKit 등), **amd64+arm64 멀티 아키텍처** (Apple Silicon macOS VM) | amd64만 | PRV-09 |
| D-22 | AWS 컨테이너는 **ECS Fargate/Express Mode** | App Runner | App Runner 2026-04-30부터 신규 고객 불가 |
| D-23 | 메인 클라우드 **GCP Cloud Run** 우선 | AWS 우선 | 가장 빠르게 붙음, 트래픽 분할 카나리 |
| D-24 | 승인된 패치 적용 시 **새 소스 버전(patched)** 생성, 빌드 산출물은 빌드한 소스 버전 기록 | 패치를 매번 재적용 | 재현성·재배포 |
| D-25 | 생성 리소스는 배포가 아니라 **IaC 스택(프로젝트×대상 환경)**에 귀속 | 최초 생성 배포에 귀속 | 후속 배포가 같은 리소스를 변경 |
| D-26 | approvals 쓰기 소유 = **오케스트레이터** (API는 결정 전달) | API 서버 소유 | 만료 처리와 소유 일치 |
| D-27 | ID는 BIGINT 자동 증가 (외부 노출 ID를 UUID로 바꿀지는 미결정) | — | — |

## 미결정 (팀 편성 후 첫 회의에서)
| # | 결정 | 선택지 | 기준 |
|---|---|---|---|
| P-01 | IaC 엔진 | Pulumi Automation API / Terraform CLI | 코드 내장 vs 레퍼런스 양 (Defang이 클라우드별 Pulumi 프로바이더 오픈소스 공개 — 참고) |
| P-02 | 백엔드 언어 | TS / Go / Java(Kotlin) | 팀 역량, AI SDK·Pulumi 지원 |
| P-03 | Postgres 큐 라이브러리 | pg-boss(Node) / River(Go) / 직접 구현 | 언어 따라 |
| P-04 | IR 형식 | Compose 확장 / 자체 스키마 | 친숙함 vs 표현력 |
| P-05 | 온프레미스 런타임 | Docker Compose / k3s | 단순함 vs 롤링·자동 확장 |
| P-06 | 샌드박스 방식 | 루트리스 BuildKit / 컨테이너 격리 / 마이크로 VM | 보안 vs 난이도 |
| P-07 | LLM | 모델·공급자 | 코드 수정 품질, 비용 |
| P-08 | 외부 노출 ID | BIGINT / UUID | 추측 방지 |
| P-09 | 데모에서 실제로 보여줄 M 기능 vs 설계로만 보여줄 M 기능 | — | 일정 |

## 참고 레퍼런스
Defang(defang.io, AI DevOps 에이전트, Compose→AWS/GCP/Azure, Pulumi 프로바이더), Qovery(AI Copilot, BYOC k8s), Northflank(BYOC), Encore·Nitric·SST(코드→인프라), Kamal·Coolify·Dokku·CapRover(온프레미스), Railpack·Buildpacks, Terraform/OpenTofu·Pulumi

## 대체된 결정 (9/29~9/30)
| 기존 | 대체 | 내용 |
|---|---|---|
| D-01 (호스팅 플랫폼 아님) | D-40 | 사용자 계정 방식이 기본이지만 운영진 답변에 따라 PaaS 전환 가능 |
| D-10 (SSE는 Redis 경유) | D-31 | P0는 API 1대 메모리에서 SSE, Redis Streams는 P1 |
| D-13 (오케스트레이터 활성 1+대기 1, API N대) | D-28 | API + 오케스트레이터 단일 프로세스 한 대 |
| D-18 (전 환경 Pyroscope) | D-45 | 관측은 P2, 메트릭 + Loki 로그 정도 |
| D-19 (추천 엔진) | D-38 | 프로필 추천은 P2, P0는 사용자가 대상 선택 |
| D-21 (amd64+arm64) | D-33 | linux/amd64 단일 (온프레미스 = Intel Mac VM) |
| D-23 (GCP Cloud Run 메인) | D-32 | AWS ECS + 온프레미스가 P0, GCP · Azure는 P2 |
| P-01 (IaC 엔진 미결) | D-34 | Terraform CLI |
| P-04 (IR 형식 미결) | D-35 | 자체 스키마 (Zod), 앱 요구사항만 |
| P-05 (온프레미스 런타임) | D-32 | Docker Compose |

## 확정 (9/29 절충안 v5.4.1 · 9/30 회의)
| # | 결정 | 버린 대안 | 이유 · 출처 |
|---|---|---|---|
| D-28 | API 서버 + 오케스트레이터 **단일 프로세스**, 통합 워커(job_type 핸들러) | 컴포넌트별 프로세스 | 구현 단순, 해커톤 규모 · 절충안 |
| D-29 | 작업 큐 Postgres 유지 (SKIP LOCKED + LISTEN/NOTIFY), 상태 전이 = 한 트랜잭션 | Redis · Temporal | D-11 계승 |
| D-30 | env_lock은 **target 승인 직후** 획득, lease 만료 해제 | 접수 시 획득 | D-15 계승 |
| D-31 | SSE: P0는 API 메모리, P1 Redis Streams | 처음부터 Redis | 단일 프로세스라 불필요 |
| D-32 | P0 대상 = **AWS ECS(Fargate) + 온프레미스(Intel Mac VM, Docker Compose, 에이전트 롱 폴링, Cloudflare Tunnel)**. GCP · Azure = P2 프로필 | GCP 메인 · 3사 동시 | 일정 · 팀 역량 · 인프라 경험(AWS) |
| D-33 | 빌드 **1회**, linux/amd64, 같은 digest를 두 환경이 pull (온프레미스는 읽기 전용 IAM으로 ECR) | 환경별 빌드 · 멀티 아키텍처 | 이식성 증명, Intel Mac |
| D-34 | IaC = **Terraform CLI**, S3 backend + use_lockfile · 버전 관리 · SSE-KMS | OpenTofu, Pulumi | 자료 · 숙련도 |
| D-35 | **IR = 앱 요구사항만** (서비스 유형 · 포트 · 헬스 · env · secrets · 논리 리소스 · 크기 · expose), 다중 서비스 스키마 | IR에 인프라 표현 | 민서님 의견 |
| D-36 | **프로필 = 환경별 검증된 인프라 골격 + capabilities**, 어댑터는 매핑만 | 서비스 유형별 프로필, 어댑터가 설계 | 민서님 의견, 원클릭 |
| D-37 | 프로필에 없는 요소 = **먼저 알림 → 사용자가 추가/제외**, 결정은 IR에 기록 | 부분 배포 · 자동 대체 | 이정 의견 |
| D-38 | 배포 대상 선택 **필수, 기본값 없음** | 두 환경 기본 체크 | 이정 |
| D-39 | 확장 모듈: **P1 팀 검증 애드온 / P2 사용자 정의(Registry · 직접 · AI 생성, "검증 안 됨")**, 골격 output → 모듈 input, 모듈 output → 앱 env | 전부 P1 | 팀원 제안(9/29 밤) |
| D-40 | **사용자 계정 방식**(사용자 AWS 키/역할로 사용자 계정에 인프라 생성)으로 진행, **운영진 불가 답변 시 PaaS 전환** | PaaS 확정 | 9/30 회의. 독창성 · 유연성 · 전환 용이 |
| D-41 | 데모 = **배포 갱신(v1 → v2) + 온프레미스 ↔ 클라우드 전환** | 전체 인프라 생성 과정 시연 | 9/30 회의, 운영진 답변 무관 |
| D-42 | P0/P1은 간단한 벤더별 프로필만, P1/P2에 소스 분석 후 없는 모듈을 레지스트리 · 추가 모듈로 덧붙임 | — | 9/30 회의 |
| D-43 | **DB는 P1 1순위** (P0 제외), SQLite → Postgres는 배포본만 규칙 변환 + raw SQL 경고, `DATABASE_URL` 하나로 주입 | P0 포함 | 9/30 김민서(네트워크 · 시크릿 · 마이그레이션이 따라옴) |
| D-44 | P0 입력 = 웹 업로드, **CLI · CI · Git = P2 이하** | CLI · CI P1 | 9/30 신은영(시연에서 안 보임) |
| D-45 | 관측은 P2, 범위는 메트릭 + Loki 로그 정도 (트레이스 · 프로파일링 X) | Grafana LGTM 전체 | 9/30 이정 |
| D-46 | **원클릭 강조**: 사용자 입력 최소화(시크릿 · UUID 자동 생성, 포트 프레임워크 탐지 자동, 기본 ingress + HTTPS), 승인은 예민한 것만 한 번에 모아서 | 단계마다 승인 3회 | 9/30 신은영 · 이정 |
| D-47 | 분석은 규칙 기반 + 애매한 부분만 AI, IR 저장 후 재사용 | AI 전체 생성 | 9/30 합의 |
| D-48 | 배포 진행 표시 = 상태 머신 + SSE로 프론트 렌더 | 폴링 | 9/30 |
| D-49 | **모노레포** (중복 많으면 분리) | 멀티레포 | 9/30 |
| D-50 | 시크릿: Postgres AES-GCM + getSecret(), 마스터 키 SOPS + age (P1) | OpenBao | 해커톤 규모 |
| D-51 | 두 층(베이스/앱) 분리 · 사용자 계정 내 공용 RDS · apply 단계 분리 · Aurora DSQL → **채택 안 함** | — | `docs/paas-vs-user-account.md` 6절 |
| D-52 | 백엔드 언어 = **TypeScript** (Fastify + Zod + pg-boss) | Go, Java, Python(FastAPI) | 팀원 리포에 Zod IR 스키마 · Analyzer 3단계 · PoC 이미 존재 → 재사용 최대. 프론트(민성)와 언어 공유(모노레포 packages/contracts). pg-boss가 D-11·D-29(Postgres 큐 SKIP LOCKED + LISTEN/NOTIFY)와 정확 매치. Node 동시성(이벤트 루프 + 논블로킹 I/O + 워커 풀)이 우리 규모 여유. 팀 슬랙에 반대 있으면 조정. 상세: `.omc/specs/deep-interview-backend-decisions.md` |
| D-53 | 실행 모델 = **일반 애플리케이션 (ECS Fargate)** · D-32 재확정 | Lambda 하이브리드 (API Gateway + Lambda×4 + SQS + Fargate task for apply) | Lambda 15분 하드리밋으로 Terraform apply 초과 리스크(하이브리드 강제 → 순수 서버리스 불가), Postgres LISTEN/NOTIFY 불가(폴링 우회 비용), SSE 우회 복잡(API Gateway WebSocket), env_lock lease heartbeat이 stateless와 상충. 이식성 30점 물증은 IR·digest에서 나오므로 Lambda 사용은 채점 결정 요인 아님. 우리 컨트롤 플레인과 사용자 앱 런타임 대칭 유지. 상세: `.omc/specs/deep-interview-backend-decisions.md` |
| D-54 | 플랫폼 자체 호스팅 = **EC2 한 대 + Docker Compose**(web · api · worker · Postgres · buildkit · cloudflared), 접속은 **Cloudflare Named Tunnel** `console.camellia-deploy.app`, 시크릿은 SSM Parameter Store. D-53 의 "상시 실행 애플리케이션"은 유지하고 호스트만 Fargate → EC2 | ECS Fargate(D-53), EIP + A 레코드, ALB + ACM, RDS | worker 가 사용자 앱을 Docker Buildx 로 빌드(docker.sock)하고 Terraform CLI 를 실행 → Fargate 에 Docker 데몬 없음. Tunnel 은 인바운드 포트 0 · 인증서 자동 · 비용 0, 사용자 앱과 같은 방식. 해커톤 예산(약 $2.75/일). 상세: `docs/deploy-platform.md` |
| D-55 | 플랫폼 CD = **GitHub Actions(main push) → OIDC 로 IAM 역할 → SSM Run Command 로 호스트 `deploy.sh <커밋 SHA>`**. 역할은 이 리포 main 브랜치 워크플로만(aud · sub StringEquals), 권한은 플랫폼 인스턴스 + `AWS-RunShellScript` 에 대한 `ssm:SendCommand` 와 결과 조회뿐 | IAM 사용자 장기 액세스 키를 GitHub Secrets 에 저장, SSH(키 · 22번 포트) 로 접속해 배포, 호스트가 main 을 주기적으로 pull | OIDC 는 실행마다 1시간짜리 임시 자격증명이라 유출 · 회전 걱정이 없고 다른 브랜치 · PR · fork 는 역할을 못 받는다. SSM 은 D-54 의 "인바운드 포트 0" 을 그대로 유지하고 4.4 수동 갱신과 같은 경로라 새 배포 방식이 생기지 않는다. 폴링 방식은 실패 · 결과가 GitHub 에 안 보인다. 상세: `docs/deploy-platform.md` 4.7 |
| D-56 | 플랫폼 AI 모델 업그레이드 **분석 보완 Claude Opus 4.5 → Opus 5.5, 실패 진단 Sonnet 4.6 → Sonnet 5.5**, 제공자는 `createClient` 한 곳에서 `AI_PROVIDER`(anthropic · bedrock, 미설정이면 키 유무)로 고르고 **현재 운영은 Claude API**(키 · `AI_PROVIDER` 는 SSM). Bedrock(`bedrock-runtime`, global 추론 프로파일) 코드 경로는 남겨 두되 보류. Opus 5.5 · Sonnet 5.5 는 강제 `tool_choice` 를 400 으로 거절 → 분석 보완은 강제 tool_use 대신 **구조화 출력**(`output_config.format`), 진단도 같은 방식. effort 명시(분석 low · 진단 medium), `max_tokens` 16000(thinking 포함), `stop_reason` refusal · max_tokens 처리 | Bedrock + EC2 인스턴스 역할(IMDS hop limit 2), Bedrock Mantle 엔드포인트(`AnthropicBedrockMantle`), 모델 유지(Opus 4.5 · Sonnet 4.6) | Bedrock 은 계정 접근이 막혀 있다(사용 사례 양식 · agreement 처리 후에도 "not available for this account ... contact AWS Sales"). 인스턴스 역할 방식은 hop limit 2 가 필요한데, 그러면 같은 호스트의 사용자 앱 빌드 컨테이너도 인스턴스 역할로 플랫폼 시크릿(SSM)을 읽을 수 있어 버렸다 → Bedrock 전환 때는 Bedrock 만 되는 전용 자격 증명을 worker 에만 준다. Mantle 은 서울에서 두 모델을 404("does not exist")로 응답했고 문서상 구조화 출력 미지원이라 `bedrock-runtime` 경로로 구현. 구조화 출력은 JSON 만 받으려던 강제 tool_use 의 정석 대체. 상세: `docs/deploy-platform.md` 4.8 |
| D-57 | 플랫폼 Terraform = **S3 원격 state(버전 관리 · SSE-S3 · use_lockfile) + GitHub Actions 로 PR 에 plan 코멘트, main 머지 때 CI 가 apply**. OIDC 역할 둘: tf-plan(PR · main, 읽기 전용 · Cloudflare token 2개만), tf-apply(main 만, 이 설정의 리소스 종류만 · EC2 삭제/변경은 플랫폼 태그 조건). infra 가 바뀐 push 는 deploy-platform 워크플로 안에서 Terraform 을 먼저 호출(`needs:`)하고 성공해야 배포 | 로컬 state + 한 사람이 로컬 apply, Terraform Cloud/HCP, Atlantis, 관리형 ReadOnlyAccess · AdministratorAccess 역할, 별도 워크플로 + `workflow_run`/폴링으로 배포 순서 맞추기 | 로컬 state 는 그 PC 가 없으면 아무도 plan · apply 를 못 하고 변경이 리뷰되지 않는다. S3 + use_lockfile 은 리포 규칙(사용자 앱 backend)과 같고 DynamoDB 가 필요 없다. HCP · Atlantis 는 외부 서비스 · 서버가 하나 더 생긴다. ReadOnlyAccess 는 PR 에서 받을 수 있는 역할이 모든 SSM SecureString · S3 객체를 읽게 된다. 한 워크플로 `needs:` 는 push 당 배포 1회 · apply 후 배포를 보장하고 docs 전용 push 건너뛰기를 그대로 둔다(workflow_run 은 infra 미변경 push 를 따로 처리해야 하고, 폴링은 대기 · 경합이 생긴다). 남는 위험: tf-apply 는 camellia-platform-* IAM 을 고칠 수 있어 사실상 관리자 상당 → main 보호가 경계. 상세: `docs/deploy-platform.md` 8절 |

## 미결 (9/30 기준)
| # | 결정 | 선택지 | 기한 |
|---|---|---|---|
| Q-02 | P0 방식 최종 | 사용자 계정 유지 / PaaS 전환 | 운영진 답변 (9/30 오전) |
| Q-03 | P1 DB 방식 | 앱별 DB 생성 / 공용 RDS + 스키마 분리 | 기능 명세 작성 시 |
| Q-04 | 비용 엔진 | P1 최소 월 추정 / P2 | 목요일 |
| Q-05 | 테이블 축소 | 33 → 22 | 스키마 작성 시 |
| Q-06 | 데모 앱 | 가볍지만 빌드되는 앱 | 목요일 |
| Q-07 | 환경 전환 구현 | 앞단 프록시(Cloudflare) 트래픽 전환 | 목요일 |
| Q-08 | 승인 게이트 재설계 | 3개 → "예민한 것만 한 번에" | 기능 명세 작성 시 |
