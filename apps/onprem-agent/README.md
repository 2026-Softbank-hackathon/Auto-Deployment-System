# On-Prem Agent

`@camellia/onprem-agent`는 서버가 전달한 `OnpremDockerDeploymentPlan`과 ECR 불변 digest를 온프레미스 Docker에 실행하고, 실제 Tunnel endpoint를 확보한 뒤 `ready_for_verify` 결과를 만드는 데이터 플레인 애플리케이션입니다.

## 현재 범위

- Agent job·ECR credential·결과 계약과 런타임 검증
- 단기 ECR 인증정보 조회 경계, `docker login --password-stdin`, digest pull·inspect, 항상 logout
- job별로 격리된 Compose project와 loopback 동적 포트
- 컨테이너 실행 상태와 로컬 HTTP health 확인
- 중복 job, 완료 결과, 실행 중 같은 digest, 새 digest 교체, 실패 재시도, 취소 처리
- 동적 `localUrl` 보고 뒤 받은 Named Tunnel session으로 `cloudflared` 실행
- Tunnel Token을 `TUNNEL_TOKEN` 환경변수로만 전달하고 프로세스 준비·교체·정리
- Intel Mac 사전검사와 macOS `LaunchAgent` 설치 기반
- `TunnelProvider` 인터페이스와 테스트 전용 `FakeTunnelProvider`
- `AgentControlPlaneClient` 인터페이스와 테스트 전용 `FakeControlPlaneClient`

외부 노출 방식은 플랫폼 관리 Cloudflare Named Tunnel로 확정됐습니다. Agent는 Compose의 동적 포트로 로컬 헬스체크를 통과한 뒤 `jobId`와 `localUrl`을 서버 경계에 전달하고, 서버가 ingress를 설정한 뒤 반환한 `tunnelId`, `token`, 외부 `hostname`으로 `cloudflared`를 실행합니다. Agent 결과의 `endpoint`는 검증된 hostname에 `https://`를 적용해 생성합니다.

서버 Agent API 경로는 아직 확정되지 않았습니다. 따라서 실제 HTTP Control Plane Client는 구현하지 않았고, `src/main.ts`도 설정·Docker·Compose·`cloudflared` 사전검사 후 미연결 상태를 명시하고 종료합니다. 임의의 서버 endpoint나 Fake endpoint를 실제 서버에 보고하지 않습니다.

## 설정

필수 환경변수는 다음과 같습니다.

- `ONPREM_AGENT_ID`: 영숫자로 시작하는 Agent 식별자
- `ONPREM_AGENT_REGISTRATION_TOKEN`: 최초 등록 개발 테스트에만 사용할 1회용 토큰

등록 토큰은 장기 런타임 인증정보가 아니며 LaunchAgent plist나 설치 파일에 저장하지 않습니다. 실제 등록 API가 연결되면 단기 TTL의 1회용 등록 토큰을 장기 Agent 인증키로 교환합니다. poll·heartbeat·취소 확인 주기와 상태 디렉터리는 `.env.example`을 참고합니다. 등록 토큰, Agent 인증키, ECR password, Tunnel Token, 컨테이너 환경변수 값은 구조화 로그에 기록하지 않습니다.

## ECR 보안 경계

Agent는 사용자의 장기 AWS Access Key를 입력으로 받지 않습니다. 서버에서 해당 job에 한정된 ECR 로그인 자격증명을 조회하고 만료 시각, Registry 일치 여부, AWS Region, ECR hostname을 검증합니다. password는 CLI 인자가 아니라 stdin으로만 전달합니다.

성공·실패·취소와 관계없이 `docker logout`을 실행합니다. 이 logout은 로컬 Docker 인증정보를 제거하는 동작이며, 이미 발급된 ECR 토큰 자체를 AWS에서 무효화하지는 않습니다. ECR 토큰은 AWS가 정한 유효기간에 따라 만료됩니다.

Compose 파일에는 환경변수 이름만 기록하고 값은 `docker compose` 프로세스 환경으로 전달합니다. Agent가 만든 project에는 `io.camellia.*` label을 부여하며 실패·취소·교체 시 해당 project만 정리합니다.

## Named Tunnel 보안 경계

원격 관리 Named Tunnel의 Token은 `cloudflared` 명령 인자나 파일에 기록하지 않고 자식 프로세스의 `TUNNEL_TOKEN` 환경변수로만 전달합니다. 등록 토큰과 AWS 자격증명을 포함한 Agent 프로세스의 전체 환경은 상속하지 않습니다. Agent는 loopback metrics `/ready`가 성공해야 Tunnel을 활성 상태로 간주하며, 취소·실패·교체·Agent 종료 시 자신이 시작한 프로세스만 종료합니다.

## Intel Mac 설치 기반

P0 대상은 Intel Mac(`x86_64`)입니다. 특정 Docker 제품에 결합하지 않고 로그인 사용자 세션에서 다음 명령이 동작해야 합니다.

```bash
docker info
docker compose version
cloudflared --version
```

Release bundle 또는 로컬 build 결과에 `dist/main.js`와 `dist/launchd-cli.js`가 있는 상태에서 설치 자산을 실행합니다.

```bash
pnpm --filter @camellia/onprem-agent build
apps/onprem-agent/install/macos/install.sh
```

설치 스크립트는 Agent 파일과 plist를 준비하지만 서버 등록 API가 없는 현재 상태에서는 서비스를 자동 시작하지 않습니다. 등록과 장기 인증키 연결이 완료된 뒤 설치된 `camellia-onprem-agent-service start`로 로그인 사용자의 `LaunchAgent`를 활성화합니다. `service.sh`는 `start`, `stop`, `restart`, `status`를 제공하고 `uninstall.sh`는 Agent와 plist를 macOS 휴지통으로 이동하며 로그는 보존합니다.

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

현재 개발 머신에는 `cloudflared`와 실제 Cloudflare 계정·Tunnel Token이 없으므로 실제 외부 Tunnel 연결은 검증 대상에서 제외합니다. 백그라운드 프로세스의 실제 시작·종료와 Docker Compose 통합은 로컬에서 별도로 검증합니다.
