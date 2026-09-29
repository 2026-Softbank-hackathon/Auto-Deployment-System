# 아키텍처 절충안 v5.4.1 (2026-09-29, 현행)

- 다이어그램: `docs/diagrams/v5/architecture_v5.4.1.png`(전체), `pipeline_v5.4.1.png`(파이프라인 확대). 생성기 `tools/diag/`
- 근거: 팀원 문서 `docs/reference/team/ARCHITECTURE_IMPROVEMENTS_v1.md`, `ARCHITECTURE_v2_ONBOARDING.md` + 민서 · 서현 · 이정 의견
- 원칙: **구현은 단순하게**, 데모는 P0 한 흐름을 끝까지, 나머지는 P1/P2
- ⚠️ 9/30 회의로 바뀐 점은 맨 아래 "9/30 이후 변경" 참고 (다이어그램에는 아직 미반영)

## 1. 핵심 결정
- **API 서버 + 오케스트레이터 = 단일 프로세스** (Fastify 가정). 한 대 운영 → 리더 선출 불필요
- **통합 워커 1개 + job_type 핸들러**: analyze · build · provision · verify. Postgres 큐, 작업 공간 격리, 멱등(job_id + attempt)
- **작업 큐 = Postgres** (SKIP LOCKED + LISTEN/NOTIFY). 별도 브로커 없음. 상태 변경 + 작업 생성 = 한 트랜잭션
- **env_lock**: 환경 단위 락, lease 만료로 해제. target 승인 직후 획득
- **채널**: 웹 P0 / CLI · CI P1(공식 요구 #5) → 9/30에 P2 이하로 내림 / MCP · llms.txt P2 / Slack 봇 제외
- **대상**: AWS(ECS) + 온프레미스(Intel Mac VM, amd64). GCP · Azure는 P2 프로필 확장으로만
- 실행 단위: api · worker · web (+ onprem-agent)

## 2. IR + 환경 프로필
- **IR = 앱 요구사항만**: 서비스 유형(http · worker · static · job), 포트, 헬스, env, secrets, 논리 리소스(db · cache), 크기(small/medium), expose
- 스키마는 처음부터 다중 서비스, P0는 하나만 사용
- **프로필 = 환경별로 미리 검증한 인프라 골격** + capabilities 선언
	- `aws-ecs-basic`: VPC · ALB · ECS (Terraform 모듈)
	- `onprem-docker-basic`: Docker Compose + Cloudflare Tunnel
	- capabilities: 지원 서비스 유형 · 리소스 · 크기 단계, 골격 출력(vpc_id · subnet_ids) 제공
- **어댑터**: IR 값 → 프로필 모듈 변수 매핑만 (port · health · size → 실행 사양, expose → ALB · Tunnel). 인프라를 새로 설계하지 않음
- 서비스는 언어가 아니라 **실행 방식 기준**으로 분리 → 섞인 코드베이스도 서비스 단위 배포

IR 예시 (YAML):
```yaml
name: todo-app
version: 1.2.0
services:
  api:
    type: http
    build: ./Dockerfile
    command: [node, server.js]
    port: 3000
    health: /health   # → 200
    env: [NODE_ENV]
    secrets: [JWT_SECRET]   # P1
    expose: public
    size: small
resources:
  db: postgres    # 애드온 (P1)
  cache: redis    # 프로필에 없음 → 빠진 요소
```
- 검증: `IrSchema.parse()` (Zod), `ir_versions` 저장, IR diff 뷰
- 팀원 문서의 IR 최상위 6필드(metadata · services · resources · deploy · overrides · expose)와 맞출 것

## 3. 파이프라인 (5단계)
1. **대상 선택 · 소스 입력** (웹 + API)
	- 배포 대상 선택 **필수, 기본값 없음** (AWS · 온프레미스 중 1개 이상) = 프로필 확정
	- API: 인증 · 크기 · 형식 검증 → 소스 zip → 오브젝트 스토리지, `source_versions`(sha256), `deployments = received` + analyze job (한 트랜잭션)
	- 환경변수 · 시크릿(P1): 값은 암호화 저장소로만, 응답은 `secret://…` 참조, AI에는 키 이름만
2. **감지 · IR 생성** (분석 핸들러 + 사용자 + AI)
	- `stageSource(deploymentId)`: 배포별 소스 카피 (원본 오염 방지)
	- ① 서비스 분리 · 규칙 감지 (폴더 · compose 기준, 실행 방식, 포트 · 명령 · 헬스 · env 이름)
	- ② 사용자 입력 (감지 못 한 칸, 공개 여부, 크기) → 9/30: **최소화**
	- ③ AI 빈칸 채우기 (남은 unknown만 tool_use, prompt caching, 시크릿 값 미전송, 칸마다 출처 표시)
	- 승인 게이트 1 · patch (P1): SQLite+Drizzle → Postgres(규칙), raw SQL 위치 표시 + 경고, Dockerfile 없으면 AI 생성(P0는 Railpack), diff 승인 → 배포본에만 적용
3. **IR 검증 · 프로필 대조** (오케스트레이터 + 프로필)
	- 스키마 검증 → capabilities 비교 (예: http ✓, postgres ✓(P1 애드온), redis ✕)
	- **빠진 요소 먼저 알림** → [확장 모듈 추가] / [제외하고 진행], 결정은 IR에 기록 → 재질문 없음
	- 승인 게이트 2 · target: 프로필 · 빠진 요소 결정 확정, 직후 env_lock 획득
4. **빌드 · 어댑터 연결** (빌드 · 프로비저닝 핸들러)
	- 이미지 1회 빌드: BuildKit linux/amd64, 없으면 Railpack, ECR 푸시 → digest 하나, 두 환경 공유
	- 어댑터 연결, 확장 모듈 연결 (골격 output → 모듈 input, 모듈 output → 앱 env)
	- plan(): 스택별 S3 state key, `init -backend-config`, `plan -out`, (P2) 사용자 모듈은 validate 먼저
	- 승인 게이트 3 · plan: 골격 + 확장 모듈 리소스 한 번에 확인
5. **배포 · 검증** (프로비저닝 · 검증 핸들러)
	- apply: `terraform apply plan.bin` (S3 락), 온프레미스는 에이전트 롱 폴링 수신, 두 환경 같은 digest pull
	- 롤아웃: AWS ECS 롤링 + 서킷 브레이커 (P0), 온프레미스 헬스 게이트 교체 (P0), blue/green · 카나리 (P2)
	- DB 바인딩 (P1): RDS · Postgres 컨테이너, `DATABASE_URL` 하나로 주입, 마이그레이션 선실행
	- 헬스체크: `/health` → 200 연속 3회 (P1 스모크, P2 k6 · 카나리)
	- 완료: AWS URL + 온프레미스 URL, env_lock 해제, succeeded
	- 환경 전환 (P2 → 9/30 데모 포인트): 고정 도메인 → 스위치 대상 변경, 장애 시 자동(상태 없는 앱만), 옛 환경 정리

**실패 경로**: P0 = 실패 단계에서 멈추고 로그 + hint, AWS는 서킷 브레이커가 이전 버전으로 자동 롤백, 락은 lease 만료로 해제 / P1 = AI 진단(로그 꼬리 + 설정 파일, 시크릿 제외) → 패치 초안 → 승인 → 새 source_version으로 재시도(최대 3회)

**상태 (정상 경로)**: received → analyzing → (P1) awaiting_patch_approval → awaiting_target_confirmation → queued → building → planning → awaiting_plan_approval → provisioning → deploying → verifying → succeeded (전체 16상태)

**SSE 이벤트**: state_changed, analysis.progress, approval_requested, lock.changed, step_completed (P0는 API 메모리 → 웹, P1 Redis Streams)

**Postgres 기록 (쓰기 소유 컴포넌트만)**: deployments, source_versions, jobs, analysis_reports, ai_usage, (P1) patches, ir_versions, approvals, env_locks, deployment_services(digest), infra_plans, iac_stacks, provisioned_resources, deployment_steps, deployments.public_url

## 4. 확장 모듈 (프로필에 없는 인프라)
- 골격 **위에** 얹음. 어댑터가 골격 출력(vpc_id, subnet_ids)을 모듈 입력에 연결, 모듈 출력(redis_url)을 앱 env(REDIS_URL)로
- **P1: 팀이 미리 검증한 애드온** (Postgres, Redis 등), AI 개입 없음, "검증됨"
- **P2: 사용자 정의** — ② Registry 허용 목록(AI는 입력값만) ③ 사용자 직접 작성 ④ AI 생성(최후). 모두 "검증 안 됨", validate + plan 승인 필수
- AI가 인프라에 관여하는 범위를 단계별로 제한하는 구조 (아예 안 한다는 뜻 X)

## 5. 저장소 · 외부
- Postgres (P0): 단일 진실 원천, 작업 큐
- Redis (P1): P0는 API 1대 메모리 SSE, 여러 대면 Streams
- 오브젝트 스토리지 (P0): MinIO/S3, 소스 zip, IR 스냅샷, 단계별 로그
- IaC state (P0): S3 + use_lockfile · 버전 관리 · SSE-KMS, key = 프로젝트 × 환경
- 시크릿 (P1): Postgres AES-GCM + `getSecret()`, 마스터 키 SOPS + age
- LLM API (Anthropic): IR 빈칸, (P1) 패치 · 진단 · (P2) 모듈 선택, prompt caching
- 레지스트리: ECR 1회 푸시, 온프레미스는 읽기 전용 IAM으로 pull
- 자격증명: 사용자 AWS 계정 AssumeRole (데모는 팀 계정) — 9/30 회의에서는 "사용자 AWS 키 등록"으로 표현됨

## 6. 관측 (P2)
- P0 대체: 웹 대시보드의 단계 로그 + 헬스체크 결과
- P2: Grafana LGTM (Grafana · Prometheus · Loki · Pyroscope · OTel Collector), CloudWatch · Docker 로그 통합 조회
- 9/30: 조서현 · 안우진 잠정 담당, 메트릭 + Loki 로그 정도로 축소 제안(이정)

## 7. 우선순위 (v5.4.1 표기 → 9/30 수정 반영)
- **P0**: 웹 업로드 · 규칙+AI 분석 · IR/프로필 대조 · 빠진 요소 알림 · 1회 빌드 · AWS ECS + 온프레미스 배포 · 헬스체크 · 승인 게이트 target/plan · SSE 로그
- **P1**: **DB 변환 · Postgres 애드온 (1순위)** · 팀 검증 확장 모듈 · 시크릿 · Redis Streams · AI 패치/진단 · 스모크 · 이전 digest 롤백 · 비용 월 추정(미결) · 환경 전환(데모 포인트)
- **P2 이하**: **CLI · CI · Git** · 사용자 정의 모듈 · MCP · 관측성 · blue/green · 카나리 · GCP/Azure · 프로필 추천

## 8. 9/30 이후 변경 (다이어그램 미반영)
- CLI · CI → P2 이하
- DB → P1 1순위
- 데모 = 배포 갱신 + 온프레미스 ↔ 클라우드 전환 → 환경 전환을 실질적 P1로 당겨야 함
- 원클릭 강조: 사용자 입력 · 승인 최소화 → 승인 게이트 3개를 "예민한 것만 한 번에 모아서"로 재설계 필요
- 사용자 계정 방식 (불가 시 PaaS) → PaaS면 프로필 = "기반 + 앱 배치 템플릿"으로 바뀜 (`docs/paas-vs-user-account.md`)
- 서버리스 백엔드 안(API Gateway + Lambda + DynamoDB) 미결
