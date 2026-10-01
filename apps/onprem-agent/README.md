# On-Prem Agent

`@camellia/onprem-agent`는 서버가 전달한 `OnpremDockerDeploymentPlan`과 ECR 불변 digest를 온프레미스 Docker에 실행하고, 실제 Tunnel endpoint를 확보한 뒤 `ready_for_verify` 결과를 만드는 데이터 플레인 애플리케이션입니다.

## 현재 범위

- Agent job·ECR credential·결과 계약과 런타임 검증
- 단기 ECR 인증정보 조회 경계, `docker login --password-stdin`, digest pull·inspect, 항상 logout
- job별로 격리된 Compose project와 loopback 동적 포트
- 컨테이너 실행 상태와 로컬 HTTP health 확인
- 중복 job, 완료 결과, 실행 중 같은 digest, 새 digest 교체, 실패 재시도, 취소 처리
- `TunnelProvider` 인터페이스와 테스트 전용 `FakeTunnelProvider`
- `AgentControlPlaneClient` 인터페이스와 테스트 전용 `FakeControlPlaneClient`

서버 Agent API 경로와 Cloudflare Quick/Named Tunnel 방식은 아직 확정되지 않았습니다. 따라서 실제 HTTP Control Plane Client와 실제 Tunnel Provider는 의도적으로 구현하지 않았고, `src/main.ts`도 설정 검증 후 미연결 상태를 명시하고 종료합니다. 임의의 서버 endpoint나 Fake endpoint를 실제 서버에 보고하지 않습니다.

## 설정

필수 환경변수는 다음과 같습니다.

- `ONPREM_AGENT_ID`: 영숫자로 시작하는 Agent 식별자
- `ONPREM_AGENT_REGISTRATION_TOKEN`: 최초 등록 또는 인증에 사용할 토큰

poll·heartbeat·취소 확인 주기와 상태 디렉터리는 `.env.example`을 참고합니다. 등록 토큰, ECR password, 컨테이너 환경변수 값은 구조화 로그에 기록하지 않습니다.

## ECR 보안 경계

Agent는 사용자의 장기 AWS Access Key를 입력으로 받지 않습니다. 서버에서 해당 job에 한정된 ECR 로그인 자격증명을 조회하고 만료 시각, Registry 일치 여부, AWS Region, ECR hostname을 검증합니다. password는 CLI 인자가 아니라 stdin으로만 전달합니다.

성공·실패·취소와 관계없이 `docker logout`을 실행합니다. 이 logout은 로컬 Docker 인증정보를 제거하는 동작이며, 이미 발급된 ECR 토큰 자체를 AWS에서 무효화하지는 않습니다. ECR 토큰은 AWS가 정한 유효기간에 따라 만료됩니다.

Compose 파일에는 환경변수 이름만 기록하고 값은 `docker compose` 프로세스 환경으로 전달합니다. Agent가 만든 project에는 `io.camellia.*` label을 부여하며 실패·취소·교체 시 해당 project만 정리합니다.

## 검증

```bash
pnpm --filter @camellia/onprem-agent test
pnpm --filter @camellia/onprem-agent typecheck
pnpm --filter @camellia/onprem-agent lint
```

Docker 통합 테스트는 Docker daemon과 이미지 빌드가 가능한 환경에서만 명시적으로 실행합니다.

```bash
RUN_DOCKER_INTEGRATION=1 pnpm --filter @camellia/onprem-agent test:integration
```
