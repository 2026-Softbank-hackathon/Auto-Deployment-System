# P0 Cloudflare 연결과 검증 후 Origin 활성화

## 실행 설정

API와 Worker에 다음 네 환경변수를 동일하게 전달한다. Worker는 env 파일을 자동 로딩하지 않으므로 실행 환경에서 주입한다.

- `CLOUDFLARE_ACCOUNT_ID`: 플랫폼 Tunnel 소유 계정
- `CLOUDFLARE_API_TOKEN`: 해당 계정 Tunnel 관리 및 Zone DNS 수정 권한
- `CLOUDFLARE_ZONE_ID`: NS 위임을 완료한 플랫폼 DNS Zone
- `DEMO_PLATFORM_DOMAIN`: 플랫폼 도메인, 예: `example.com`

고정 서비스 주소는 `https://service-{projectId}.apps.{domain}`이다. 실제 토큰은 저장소에 넣지 않는다. 이번 연결은 Zone을 자동 생성하거나 등록기관 NS를 변경하지 않는다.

## On-Prem Agent 연결 — 기존 PR #112 계약 유지

1. Agent가 Compose와 로컬 헬스체크를 완료한다.
2. Agent Bearer 인증으로 `POST /api/v1/agents/jobs/{jobId}/tunnel`을 호출한다.

```json
{ "deploymentId": 42, "environmentId": "12", "localPort": 32145 }
```

3. 서버가 Agent/Job/lease를 검증하고 프로젝트의 Named Tunnel을 준비한다. 후보 주소는 `verify-d42.{domain}`, ingress는 `http://127.0.0.1:32145`이다.
4. Agent가 반환된 Tunnel token으로 cloudflared를 실행하고 `ready_for_verify` 결과를 보고한다.
5. 서버가 결과와 localUrl을 저장하고 Verify Job을 enqueue한다. Agent 결과만으로 최종 성공 처리하지 않는다.

## Verify → 고정 Origin 활성화 — 이번 작업

Worker의 `runVerifyJob`은 HTTP 검증 결과를 저장한 뒤 `DeploymentOriginActivator.activate`를 호출한다. 실패한 헬스체크에서는 활성화하지 않는다.

- AWS: 검증한 ALB hostname을 고정 서비스 CNAME의 target으로 설정한다.
- On-Prem: 저장된 Agent 결과의 endpoint·환경·digest·loopback localUrl을 대조한 후 stable ingress와 CNAME을 연결한다.
- 활성화 직전 배포가 여전히 `verifying`인지 재확인한다.
- 설정 누락 또는 Cloudflare 오류는 호출자에게 오류로 전달하며 토큰/공급자 오류 원문을 노출하지 않는다.
- Cloudflare 실패 시 성공한 헬스 기록은 유지한다. 동일 Verify Job 재시도는 헬스 검사 대신 활성화를 재시도한다.
- `register.ts`의 최종 상태/SSE/환경 락 해제는 이정 담당이다. `runVerifyJob`이 정상 반환한 뒤에만 최종 성공을 처리해야 한다. 반환값 `failed`와 throw를 모두 처리해야 한다.

DB의 `deployments.public_url`은 후보 Origin endpoint를 유지한다. API의 사용자 publicUrl은 프로젝트 기반 고정 주소이며 두 값을 혼동하지 않는다.

## 제한 및 검증

- 자동 테스트: 헬스 성공/실패, 동적 포트, digest 불일치, 취소, 재시도, 비밀 오류 원문 차단, 기존 Verify 회귀.
- 실제 AWS 앱·Cloudflare DNS/TLS·VM 전환 E2E는 별도 실행이 필요하다. 단위 테스트 통과를 실제 전환 성공으로 보고하지 않는다.
- Terraform ALB는 HTTP이다. Cloudflare origin SSL 설정과 `*.apps.{domain}`에 해당하는 인증서 범위를 실제로 확인해야 한다. API 토큰 설정만으로 HTTPS 완료가 되지 않는다.
- Tunnel ingress 변경과 DNS 변경은 원자적이지 않다. Verify 실패는 기존 stable Origin을 건드리지 않지만, 활성화 도중 실패하면 일부 변경이 남을 수 있다. 자동 롤백은 구현하지 않으며 재시도로 수렴한다.
- 프로젝트당 하나의 Tunnel을 재사용하므로 여러 VM/Tunnel connector의 동시 활성화나 같은 프로젝트의 양 환경 동시 전환은 데모 전에 직렬화해야 한다.

격리 DB 통합 테스트 재실행(Node 20+):

```sh
ORIGIN_TEST_DATABASE_URL='<로컬 개발 PostgreSQL URL>' \
  pnpm --filter @camellia/worker exec vitest run tests/origin-activation.integration.test.ts
```

테스트는 고유 schema만 생성·삭제한다. 실제 Cloudflare API는 호출하지 않는다. 설정하지 않은 일반 workspace 테스트에서는 해당 통합 테스트 2개를 skip한다.
