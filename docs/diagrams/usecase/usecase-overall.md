# 전체 시스템 Use Case Diagram — 통합 뷰

> Camellia 배포 시스템의 전체 use case 통합 뷰. 5단계 파이프라인 흐름과 담당자별 영역을 한 다이어그램에서 조망한다.

---

## 전체 시스템 통합 Use Case Diagram

```mermaid
graph TB
  Dev[개발자]
  Claude["Anthropic Claude\n(LLM API)"]
  AWS["AWS\n(ECS Fargate · ECR · RDS)"]
  Cloudflare["Cloudflare\n(Tunnel · DNS)"]
  GitHub["GitHub\n(Webhook P2)"]
  OnpremVM["온프레미스\n(Intel Mac VM, amd64)"]

  subgraph PIPE1 ["1단계: 소스 입력 (이정)"]
    P1_01["프로젝트 생성\nSRC-01"]
    P1_02["소스 zip 업로드\n+ 배포 생성\nSRC-02 / DEP-01"]
    P1_03["소스 버전 관리\n(sha256)\nSRC-04"]
    P1_04["모노레포 인식\nSRC-05"]
  end

  subgraph PIPE2 ["2단계: 분석 · IR 생성 (이정)"]
    P2_01["언어·프레임워크 감지\nANL-01"]
    P2_02["의존 리소스·env 감지\nANL-03,04"]
    P2_03["운영 위험 진단\nANL-06"]
    P2_04["AI 빈칸 채우기\n(tool_use)"]
    P2_05["IR 자동 생성\nIR-01"]
    P2_06["IR 스키마 검증\n(Zod)\nIR-02"]
    P2_07["IR 편집\nIR-03"]
    P2_08["빠진 요소 결정\n(확장 모듈 추가/제외)"]
  end

  subgraph PIPE3 ["3단계: 빌드 (은영)"]
    P3_01["Dockerfile 생성\n(Railpack 대체)\nPAT-01"]
    P3_02["이미지 빌드\n(BuildKit linux/amd64)\nBLD-01"]
    P3_03["ECR 1회 푸시\n(digest 공유)\nBLD-02,03"]
  end

  subgraph PIPE4 ["4단계: 플랜 · 프로비저닝 (은영)"]
    P4_01["Terraform plan 생성\nPRV-01"]
    P4_02["플랜 미리보기·승인\nPRV-02"]
    P4_03["ECS Fargate 배포\nPRV-04"]
    P4_04["온프레미스 배포\n(Docker Compose)\nPRV-03"]
    P4_05["DB 자동 프로비저닝\n(RDS/Postgres)\nDAT-03,04"]
    P4_06["DB 마이그레이션\nMIG-02,03"]
    P4_07["네트워크·URL 제공\nNET-01,02,03"]
    P4_08["환경 락 획득\nLCK-01,05"]
    P4_09["IaC 상태 공유\n(S3 + use_lockfile)\nLCK-03"]
  end

  subgraph PIPE5 ["5단계: 배포 검증 (민서)"]
    P5_01["롤링 배포\n(ECS 서킷 브레이커)\nDEP-08"]
    P5_02["헬스체크 게이트\n(/health 3회)\nVRF-01"]
    P5_03["스모크 테스트\nVRF-02"]
    P5_04["digest 확인\nVRF-03"]
    P5_05["검증 결과 기록\nVRF-04"]
    P5_06["자동 롤백\n(실패 시)\nDEP-09"]
  end

  subgraph WEB ["웹 대시보드 (민성)"]
    W01["프로젝트·배포 관리 UI"]
    W02["SSE 실시간 진행 표시\nDEP-03"]
    W03["분석 리포트·IR 편집 UI"]
    W04["Terraform 플랜 승인 UI"]
    W05["로그·이력 조회 UI"]
    W06["헬스체크·URL 확인 UI"]
    W07["롤백·환경 전환 UI\nSW-01~03"]
  end

  subgraph OBS ["관측·확장 (조서현·안우진 P2)"]
    O01["메트릭 (Prometheus)\nOBS-02"]
    O02["로그 집계 (Loki)\nOBS-01"]
    O03["Grafana 대시보드\nOBS-03"]
    O04["비용 예측\nCST-03"]
    O05["감사 로그\nLOG-03"]
    O06["CI/Webhook\nCI-01"]
  end

  subgraph AI_ASSIST ["AI 보조 기능"]
    A01["분석 빈칸 채우기\n(ANL, P0)"]
    A02["패치 제안\n(PAT, P1)"]
    A03["실패 진단\n(FIX, P1)"]
    A04["가드레일\n(AGT-04, P0)"]
  end

  %% 파이프라인 주 흐름
  Dev --> P1_01
  Dev --> P1_02
  P1_02 -.-> P1_03
  P1_02 -.-> P1_04
  P1_03 -.-> P2_01
  P1_04 -.-> P2_01
  P2_01 -.-> P2_02
  P2_02 -.-> P2_03
  P2_03 -.-> P2_04
  P2_04 -.-> P2_05
  P2_05 -.-> P2_06
  P2_06 -.-> P2_07
  P2_07 -.-> P2_08
  Dev --> P2_07
  Dev --> P2_08
  P2_08 -.->|"gate1: target 승인"| P3_01
  P3_01 -.-> P3_02
  P3_02 -.-> P3_03
  P3_03 -.->|"gate2: plan 생성"| P4_01
  P4_01 -.-> P4_02
  Dev --> P4_02
  P4_02 -.->|"gate3: plan 승인"| P4_03
  P4_02 -.-> P4_04
  P4_03 -.-> P4_05
  P4_05 -.-> P4_06
  P4_06 -.-> P4_07
  P4_07 -.-> P5_01
  P4_08 -.->|"env_lock 획득"| P4_03
  P5_01 -.-> P5_02
  P5_02 -.->|"3회 연속 통과"| P5_03
  P5_03 -.-> P5_04
  P5_04 -.-> P5_05
  P5_02 -.->|"실패"| P5_06
  P5_06 -.->|"롤백"| P4_03

  %% 웹 대시보드 연결
  Dev --> W01
  W02 -.->|"SSE"| P2_01
  W03 -.->|"조회/편집"| P2_05
  W04 -.->|"승인"| P4_02
  W05 -.->|"조회"| P5_05
  W06 -.->|"확인"| P5_02
  W07 -.->|"전환"| P4_04

  %% AI 연결
  P2_04 -->|"tool_use"| Claude
  A01 -.-> P2_04
  A02 -.->|"P1"| P3_01
  A03 -.->|"P1 진단"| P5_06
  A04 -.->|"승인 강제"| P4_02

  %% 외부 시스템
  P3_03 -->|"이미지 push"| AWS
  P4_03 -->|"ECS 서비스"| AWS
  P4_05 -->|"RDS 생성"| AWS
  P4_04 -->|"Compose 배포"| OnpremVM
  P4_07 -->|"Tunnel URL"| Cloudflare
  GitHub -.->|"push 이벤트 P2"| O06

  %% 관측 연결
  P5_05 -.-> O01
  P5_05 -.-> O02
  O01 -.-> O03
  O02 -.-> O03
```

---

## 담당자별 Use Case 요약

| 담당자 | 파이프라인 단계 | 주요 기능 ID | Use Case 수 |
|---|---|---|---|
| **이정** | 1~2단계 (소스·분석·IR) | SRC, ANL, IR, AGT, FIX, DAT(시크릿), CST | 29개 |
| **신은영** | 3~4단계 (빌드·프로비저닝·락) | BLD, PRV, DAT, MIG, NET, LCK, SW, AGT(에이전트) | 34개 |
| **김민서** | 5단계 (검증) | VRF, DEP(롤아웃·롤백), SCL(k6 P2) | 11개 |
| **김민성** | 웹 대시보드 | UI, 전체 API 소비 | 24개 |
| **조서현·안우진** | 관측·확장 (P2) | OBS, CST, LOG(감사), CI, SCL, USR | 18개 |

---

## 5단계 파이프라인 상태 전이

```mermaid
graph LR
  S01[received] --> S02[analyzing]
  S02 --> S03["awaiting_target_confirmation\n(빠진 요소 결정 + target 승인)"]
  S03 --> S04[queued]
  S04 --> S05[building]
  S05 --> S06[planning]
  S06 --> S07["awaiting_plan_approval\n(플랜 승인)"]
  S07 --> S08[provisioning]
  S08 --> S09[deploying]
  S09 --> S10[verifying]
  S10 --> S11([succeeded])
  S10 -.->|"검증 실패"| S12([failed])
  S05 -.->|"빌드 실패"| S12
  S08 -.->|"프로비저닝 실패"| S12
  S12 -.->|"재시도 최대 3회\nFIX-03,04"| S04
```

---

## 전체 API 엔드포인트 커버리지

| 구분 | 수 | 담당 |
|---|---|---|
| P0 API | 21개 | 이정·은영·민서·민성 |
| P1 API | 18개 | 이정·은영·민서·민성·서현/우진 |
| P2 API | 9개 | 서현/우진·공통 |
| **합계** | **48개** | — |

---

## 커버 안 되는 기능 (명시)

| 기능 ID | 설명 | 사유 |
|---|---|---|
| CST-02 | `GET /analytics/ai-roi` | V-01 미결 — 엔드포인트 미명세 (P1) |
| PRV-10 | 함수형 서버리스 어댑터 (Lambda) | P2, 시간 여유 시 구현 |
| PRV-11 | 인스턴스 어댑터 (EC2) | P2, 시간 여유 시 구현 |
| PRV-05 | GCP Cloud Run 어댑터 | P2 |
| PRV-06 | Azure Container Apps 어댑터 | P2 |
| DEP-06 | 블루그린 배포 | P2 |
| DEP-07 | 카나리 배포 | P2 |
| OBS-04 | 트레이스 | 폐기 (D-45) |
| OBS-05 | 프로파일링 (Pyroscope) | 폐기 (D-45) |
| IR-06 | Docker Compose 호환 | 폐기 (D-35) |
| BLD-05 | 멀티 아키텍처 빌드 | 폐기 (D-33) |
| LCK-04 | 개인 미리보기 환경 | 폐기 |
