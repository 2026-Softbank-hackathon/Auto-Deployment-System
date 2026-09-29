# 김민서 담당 Use Case Diagram — 배포 검증

> 담당 범위: 배포 완료 후 헬스체크, 스모크 테스트, digest 확인, 롤아웃 검증, 자동 롤백 판정까지. 배포 파이프라인의 최종 품질 게이트를 담당한다.

---

## Use Case Diagram

```mermaid
graph TB
  Dev[개발자]
  App["배포된 앱\n(ECS Fargate / 온프레미스)"]
  ECR["ECR\n(컨테이너 레지스트리)"]
  ECS["AWS ECS\n(서킷 브레이커)"]
  Onprem["온프레미스\n(Docker Compose)"]
  DB[(Postgres)]

  subgraph Minseo ["김민서 담당 — 배포 검증"]
    direction TB

    subgraph VRF ["1. 검증 핸들러 (VRF)"]
      UC01["VRF-01\n헬스체크 게이트\n(/health 200 연속 3회\n실패 시 자동 롤백 트리거)"]
      UC02["VRF-02\n스모크 테스트\n(핵심 엔드포인트 200 계열)"]
      UC03["VRF-03\ndigest 확인\n(실행 컨테이너 digest\n= 빌드 산출물 digest)"]
      UC04["VRF-04\n검증 결과 기록\n(deployment_steps\nverify row 저장)"]
    end

    subgraph DEP ["2. 배포 전략·롤아웃 (DEP)"]
      UC05["DEP-04\n배포 후 검증\n(/health 200 3회 → succeeded)"]
      UC06["DEP-08\n롤링 배포\n(ECS 롤링 + 서킷 브레이커\n온프레미스 헬스 게이트 교체)"]
      UC07["DEP-09\n자동 롤백\n(ECS 서킷 브레이커\n이전 버전 자동 복구)"]
    end

    subgraph STATUS ["3. 배포 상태 머신 (DEP-02)"]
      S01["received"]
      S02["analyzing"]
      S03["awaiting_target_confirmation"]
      S04["queued"]
      S05["building"]
      S06["planning"]
      S07["awaiting_plan_approval"]
      S08["provisioning"]
      S09["deploying"]
      S10["verifying"]
      S11["succeeded"]
      S12["failed"]
    end

    subgraph HEALTH ["4. 헬스체크 모니터링"]
      UC08["HEALTH-CHECK\n헬스체크 현황 조회\n(attempt·latency·연속통과)"]
      UC09["HEALTH-SMOKE\n스모크 테스트 실행\n(배포된 앱 엔드포인트 호출)"]
    end

    subgraph ROLLBACK ["5. 롤백 판정"]
      UC10["FAIL-DETECT\n검증 실패 감지\n(/health 실패 3회)"]
      UC11["AUTO-ROLLBACK\n자동 롤백 트리거\n(AWS: ECS 서킷 브레이커)"]
      UC12["MANUAL-ROLLBACK\n수동 롤백\n(이전 성공 digest 지정)"]
    end

    subgraph SCL_VRF ["6. 확장성 검증 (SCL, P2)"]
      UC13["SCL-05\nk6 부하 테스트\n(P2 리포트 첨부)"]
    end
  end

  %% 개발자 액션
  Dev --> UC08
  Dev --> UC12

  %% 자동 검증 파이프라인
  S09 -.->|"deploying 완료"| S10
  S10 -.-> UC01
  UC01 -.->|"3회 연속 성공"| UC05
  UC05 -.-> S11
  UC01 -.->|"실패"| UC10
  UC10 -.-> UC11
  UC11 -.-> S12
  S11 -.-> UC02
  UC02 -.-> UC03
  UC01 -.-> UC04
  UC02 -.-> UC04
  UC03 -.-> UC04
  UC04 -.-> DB

  %% 롤링 배포
  S08 -.->|"provisioning → deploying"| S09
  S09 -.-> UC06
  UC06 -.->|"AWS ECS 롤링"| ECS
  UC06 -.->|"온프레미스 교체"| Onprem

  %% 상태 전이 흐름 (정상 경로)
  S01 -.-> S02
  S02 -.-> S03
  S03 -.-> S04
  S04 -.-> S05
  S05 -.-> S06
  S06 -.-> S07
  S07 -.-> S08
  S08 -.-> S09
  S09 -.-> S10
  S10 -.-> S11

  %% 실패 경로
  S10 -.->|"검증 실패"| S12
  UC10 -.-> S12

  %% 앱 호출
  UC01 -->|"GET /health"| App
  UC02 -->|"핵심 엔드포인트 호출"| App
  UC03 -->|"digest 조회"| ECR

  %% ECS 자동 롤백
  UC11 -->|"서킷 브레이커 작동"| ECS
```

---

## 코드 매핑 표

| Use Case | 기능 ID | 파일 위치 | 담당 API |
|---|---|---|---|
| 헬스체크 게이트 (연속 3회) | VRF-01 | `apps/worker/src/handlers/verify.ts` | `GET /deployments/:id/health` (API-21) |
| 스모크 테스트 | VRF-02 | `apps/worker/src/handlers/verify.ts` | `GET /deployments/:id/health` (API-21) |
| digest 확인 | VRF-03 | `apps/worker/src/handlers/verify.ts` | `GET /deployments/:id/health` (API-21, D-53 범위 미결) |
| 검증 결과 기록 | VRF-04 | `apps/worker/src/handlers/verify.ts` | `GET /deployments/:id/health` (API-21) |
| 배포 후 검증 | DEP-04 | `apps/worker/src/handlers/verify.ts` | 워커 내부 |
| 롤링 배포 | DEP-08 | `apps/worker/src/handlers/provision.ts` | 워커 내부 |
| 자동 롤백 | DEP-09 | `apps/worker/src/handlers/verify.ts` | 워커 내부 (ECS 서킷 브레이커) |
| 헬스체크 현황 조회 | VRF-01 | `apps/api/src/routes/` | `GET /deployments/:id/health` (API-21) |
| 배포 상태 머신 | DEP-02 | `apps/api/src/` + `apps/worker/src/` | `GET /deployments/:id` (API-06) |
| 수동 롤백 | DEP-05 | `apps/api/src/routes/` | `POST /deployments/:id/rollback` (API-13) |
| k6 부하 테스트 | SCL-05 | 별도 k6 스크립트 (P2) | - |

---

## 검증 판정 기준 (완료 조건)

| 검증 항목 | 판정 기준 | 결과 |
|---|---|---|
| VRF-01 헬스체크 | `/health` 200 응답 연속 3회 | 통과 → `succeeded`, 실패 → 자동 롤백 트리거 |
| VRF-02 스모크 | 핵심 엔드포인트 200 계열 응답 | 통과 → 기록, 실패 → `failed` |
| VRF-03 digest | 실행 컨테이너 digest = 빌드 digest | D-53 Q3 범위 미결 (A=전달값 비교 / B=실제 조회) |
| VRF-04 기록 | `deployment_steps` verify row 저장 | 항상 기록 |

---

## 관련 API 엔드포인트 요약

| 우선순위 | 메서드 | 경로 | 설명 |
|---|---|---|---|
| P0 | GET | `/api/v1/deployments/:id/health` | 헬스체크 현황 조회 |
| P0 | GET | `/api/v1/deployments/:id` | 배포 상태 (상태 머신) |
| P0 | GET | `/api/v1/deployments/:id/events` | SSE 실시간 상태 스트림 |
| P1 | POST | `/api/v1/deployments/:id/rollback` | 수동 롤백 |
| P2 | - | k6 부하 테스트 스크립트 | 별도 스크립트 (SCL-05) |
