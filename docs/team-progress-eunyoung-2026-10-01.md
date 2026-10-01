# P0 배포 실행 계층 진행 상황 — 신은영

> 기준: 2026-10-01, 회의 공유용. 코드 구현과 실제 환경 검증을 구분한다.
> 프로젝트: One Action, Infinite Clouds / Camellia

## 1. 맡은 작업

IR 이후 실제 배포 실행 계층: Profile/Adapter, 이미지 Build·ECR Push·digest, 사용자 계정 Terraform Provision/Deploy, On-Prem 서버 Job 전달, Cloudflare DNS/Tunnel, Verify 입력 제공.

사용자는 `aws` 또는 `onprem`만 선택하고 서버가 기본 Profile을 결정한다. AWS는 사용자 계정에 배포하는 BYOC를 유지한다. P0의 On-Prem 이미지도 사용자 Private ECR을 사용한다.

| 담당 | 연결 경계 |
| --- | --- |
| 이정 | 업로드·분석·IR·credential 저장, Agent 등록/인증, 최종 상태·SSE·락 해제 |
| 신은영 | Profile/Adapter·Build/ECR·Terraform·On-Prem 서버 실행 연계·Cloudflare |
| 김민서 | Agent Compose/cloudflared 실행, HTTP/rollout 검증 |
| 김민성 | 벤더 선택·업로드·상태·결과 UX |
| 조서현 | 공통 계약 및 플랫폼 실행 환경 |

## 2. 전체 흐름

```text
계정 등록 + ZIP 업로드 + 벤더 선택
  → 분석 / IR / 기본 Profile
  → Adapter / Build / 사용자 ECR Push / digest 저장
  ├─ AWS: Terraform → ECS / ALB → Verify
  └─ On-Prem: Job claim → ECR 인증 → Compose → Tunnel → 결과 보고 → Verify
  → 검증 결과 저장 → 고정 URL Origin 활성화
  → 최종 상태 / SSE / 환경 락 해제 [이정 연결 필요]
```

고정 URL: `https://service-{projectId}.apps.{platformDomain}`.
Agent endpoint는 후보 검증용 URL이며 사용자 고정 URL과 다르다.

## 3. 지금까지 구현·병합한 작업

| 기능 | PR |
| --- | --- |
| AWS/On-Prem Adapter와 Profile | [#44](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/44) |
| Docker Buildx Build Handler | [#55](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/55) |
| 사용자 Private ECR | [#57](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/57) |
| 대상/Registry Environment 자동 연결 | [#60](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/60) |
| Worker Build 실행·ECR 인증·digest 저장 | [#66](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/66) |
| credential 사전 검증·사용 중 Secret 삭제 차단 | [#78](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/78) |
| Cloudflare Zone/Named Tunnel/CNAME 클라이언트 | [#82](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/82) |
| ECS Fargate/VPC/ALB Terraform Profile | [#86](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/86) |
| Terraform 실행·state key·Verify queue 연결 | [#94](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/94) |
| Agent Job 생성 | [#98](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/98) |
| Job long polling·claim/lease | [#103](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/103) |
| Agent Job 한정 ECR 단기 인증정보 | [#109](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/109) |

보완: Agent 토큰 응답 노출 제거 #67, 세션 typecheck #73, 분석 캐시 source version 누락 #75.
팀 PR #112에서 Agent HTTP Client, heartbeat/취소, 동적 localPort Tunnel API, 결과 저장 및 Verify queue 연결이 병합됐다. 해당 구현을 유지하며 중복 API를 추가하지 않는다.

## 4. 이번 마무리 작업 — 이슈 #111

- PR: [#118](https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/pull/118)
- Worker의 `runVerifyJob`에 검증 성공 후 Origin 활성화 연결.
- AWS는 검증한 ALB hostname으로 고정 CNAME 전환.
- On-Prem은 서버에 저장된 결과의 환경·endpoint·digest·동적 loopback 포트를 확인하고 stable ingress/CNAME 연결.
- Verify 실패 시 기존 stable Origin 변경 없음.
- Cloudflare 오류는 민감한 원문을 제외하고 정규화한다.
- DNS 활성화 실패 시 성공한 헬스 결과를 유지하고 동일 Job 재시도에서 활성화만 재시도한다.
- 팀 API와 `register.ts`의 terminal 처리 로직은 변경하지 않는다.

실행 설정 및 제한은 [Cloudflare 연결 문서](./onprem-cloudflare-api.md)에 기록했다.

## 5. 검증된 것 / 아직 확인 못 한 것

| 검증 | 상태 |
| --- | --- |
| 사용자 AWS 계정 ECR Build/Push/digest 저장 | 이전 실제 검증 완료, 생성 리소스 정리 완료 |
| Job 한정 ECR authorization 발급 | 이전 실제 검증 완료 |
| 전체 workspace test/typecheck/lint | 통과, lint 기존 경고만 존재 |
| 이번 Origin·기존 Verify 집중 테스트 | 29개 통과: 단위/회귀 27개 + PostgreSQL/HTTP 통합 2개 |
| 격리 PostgreSQL + 실제 HTTP 통합 | 헬스 결과 저장, 동적 포트, DNS 실패 후 캐시 재시도, HTTP 실패 시 활성화 차단 확인 |
| Agent 실제 Cloudflare Named Tunnel | PR #97 팀 기록: 외부 `/health` 200 및 임시 DNS/Tunnel 삭제 확인 |
| 서버 고정 Origin DNS/TLS 전환 | 미실행: 기존 테스트 설정의 공용 사용 여부 및 서버 설정 전달 확인 필요 |
| 실제 AWS 앱→HTTPS→v2→On-Prem 전환 전체 E2E | 미완료 |
| Agent 설치·배포 방식 | 미구현: 담당 팀원 공유 기준. Agent 동작 테스트 완료와 구분 |

PostgreSQL 통합 검증은 고유 schema를 생성하고 테스트 종료 시 삭제했다. 기존 데이터는 수정하지 않았다. 테스트에서는 후보 hostname을 로컬 HTTP 서버에 연결하고 Cloudflare 호출은 대체했다. 실제 Cloudflare/Agent/Compose 실행 성공을 의미하지 않는다.

## 6. 앞으로 해야 할 일

### 은영

- [ ] 팀 Cloudflare 설정을 받은 뒤 실제 DNS/Tunnel/고정 URL HTTPS 검증
- [ ] 민서와 실제 VM에서 ECR pull→Compose→Tunnel→Verify 통합 검증
- [ ] 사용자 API 시작 흐름으로 AWS 최초 배포와 v2 갱신 실행
- [ ] 같은 고정 URL에서 AWS↔On-Prem 전환 확인
- [ ] 테스트 생성 리소스 정리 및 결과 기록

### 팀 연결

- [ ] 이정: `runVerifyJob`의 passed/failed/throw에 따른 terminal 상태·SSE·락 해제. Origin 활성화까지 정상 반환한 뒤에만 succeeded
- [ ] 민서: ECS rollout/실제 digest 확인, VM Agent 실행 검증
- [ ] 플랫폼 배포 담당: API와 Worker 양쪽에 네 Cloudflare 환경변수 주입

플랫폼 PR #115는 EC2 + Compose에서 Worker Docker socket/Buildx 및 Railpack BuildKit 접근을 구성하고 API/Worker 양쪽 Cloudflare 환경변수를 전달하도록 되어 있다(코드 읽기 확인). 이는 플랫폼 호스팅이며 사용자 앱의 ECS Fargate Profile과 충돌하지 않는다. 실제 AWS apply 및 플랫폼 부팅은 미검증이다.

## 7. 팀에 확인할 사항

1. PR #97의 실제 테스트 Account·Zone·도메인을 플랫폼 공용으로 사용할지 확인하고 유효한 Token을 안전하게 서버에 전달. 별도 개인 계정 생성은 필요하지 않다.
2. `service-id.apps.domain` 인증서 범위와 HTTP ALB에 맞는 Cloudflare origin SSL 설정. 도메인/token만으로 HTTPS 완료가 되지 않는다.
3. 이정의 최종 상태/SSE/락 해제 반영 일정.
4. 앱 시크릿 없이 실행 가능한 데모 v1/v2 샘플 준비 여부. Agent의 앱 시크릿 전달은 현재 제외돼 있다.

Named Tunnel은 프로젝트당 하나를 재사용한다. 여러 VM connector/양 환경 동시 전환은 데모에서 피하고 순차 실행한다. Tunnel ingress와 DNS 업데이트는 원자적이지 않아 활성화 중 오류 시 일부 설정이 남을 수 있다. 자동 롤백은 없고 재시도로 수렴한다.

## 8. 슬랙 공유용

> 제 담당인 Adapter/Profile, Build/ECR/digest, Terraform 실행, On-Prem Job/단기 ECR 인증 기반은 병합돼 있습니다. 이번에는 팀 Tunnel API를 유지하면서 Verify 성공 이후 AWS ALB 또는 On-Prem Tunnel로 고정 URL Origin을 연결했습니다. 자동 검사와 격리 PostgreSQL/실제 HTTP 통합 테스트까지 통과했습니다. Agent 실제 Cloudflare 연결은 PR #97에 성공 기록이 있으며, 해당 설정을 플랫폼 공용으로 사용 가능한지 확인해 서버 측 고정 URL 전환까지 검증하겠습니다. 이정님은 `runVerifyJob` 정상 반환 이후 terminal 상태·SSE·락 해제를 연결 부탁드립니다. failed 반환과 Origin 활성화 throw도 함께 처리해야 합니다.
