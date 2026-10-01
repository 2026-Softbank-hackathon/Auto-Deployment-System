# On-Prem Agent

`@camellia/onprem-agent`는 서버가 전달한 `OnpremDockerDeploymentPlan`과 ECR 불변 digest를 온프레미스 Docker에 실행하고, 실제 Tunnel endpoint를 확보한 뒤 `ready_for_verify` 결과를 만드는 데이터 플레인 애플리케이션입니다.

## 현재 범위

- Agent job·ECR credential·결과 계약과 런타임 검증
- 단기 ECR 인증정보 조회 경계, `docker login --password-stdin`, digest pull·inspect, 항상 logout
- job별로 격리된 Compose project와 loopback 동적 포트
- 컨테이너 실행 상태와 로컬 HTTP health 확인
- 중복 job, 완료 결과, 실행 중 같은 digest, 새 digest 교체, 실패 재시도, 취소 처리
- 동적 `localPort` 보고 뒤 받은 Named Tunnel session으로 `cloudflared` 실행
- Tunnel Token을 `TUNNEL_TOKEN` 환경변수로만 전달하고 프로세스 준비·교체·정리
- Intel Mac과 Apple Silicon 사전검사, macOS `LaunchAgent` 설치 기반
- `TunnelProvider` 인터페이스와 테스트 전용 `FakeTunnelProvider`
- 등록·Heartbeat HTTP Client와 권한 제한 장기 Agent 인증정보 파일
- Job claim·ECR credential·Tunnel 준비·결과 제출 HTTP Client
- 15초 Heartbeat 기반 90초 Job lease 갱신과 취소 처리

외부 노출 방식은 플랫폼 관리 Cloudflare Named Tunnel로 확정됐습니다. Agent는 Compose의 동적 포트로 로컬 헬스체크를 통과한 뒤 `jobId`와 숫자 `localPort`를 서버 경계에 전달합니다. 서버는 `http://127.0.0.1:<localPort>`로 ingress를 설정한 뒤 `tunnelId`, `token`, 외부 `hostname`을 반환하고, Agent는 해당 정보로 `cloudflared`를 실행합니다. Agent 결과의 `localUrl`은 로컬 실행·헬스 결과로 유지하고, 외부 `endpoint`는 검증된 hostname에 `https://`를 적용해 생성합니다.

Agent는 저장된 장기 인증키로 서버를 인증한 뒤 Job을 long polling합니다. 실행 중 Heartbeat는 생존 보고, Job lease 갱신, 취소 확인을 함께 처리합니다. ECR credential과 Tunnel token 응답에는 `no-store`가 적용되며 Agent는 두 값을 메모리에서만 사용합니다.

P0 데모는 일반 환경변수만 지원합니다. `secretNames`가 포함된 Plan은 Worker와 Agent 양쪽에서 거부하며 application secret 복호화·전달은 후속 범위입니다.

## 설정

최초 등록 시에만 필요한 환경변수는 다음과 같습니다.

- `ONPREM_CONTROL_PLANE_URL`: HTTPS Control Plane origin. 로컬 개발에서는 loopback HTTP도 허용
- `ONPREM_AGENT_REGISTRATION_TOKEN`: 서버가 발급한 단기 TTL의 1회용 토큰

등록 명령은 토큰을 `POST /api/v1/agents/register`에 한 번 전달하고 발급된 장기 Agent 인증키를 기본 경로 `~/Library/Application Support/Camellia/onprem-agent/credentials.json`에 저장합니다. 디렉터리는 `700`, 파일은 `600` 권한을 강제하며 원자적으로 교체합니다. 이후 실행은 저장된 Control Plane URL과 인증키를 재사용하므로 등록 토큰이 필요하지 않습니다. 등록 토큰과 인증키는 LaunchAgent plist·명령 인자·구조화 로그에 기록하지 않습니다.

설치된 Agent의 최초 등록은 다음처럼 실행합니다.

```bash
ONPREM_CONTROL_PLANE_URL=https://server.example \
ONPREM_AGENT_REGISTRATION_TOKEN=<one-time-token> \
"$HOME/Library/Application Support/Camellia/onprem-agent/bin/camellia-onprem-agent" register
```

등록 명령은 발급된 장기 Key로 Heartbeat까지 성공해야 완료됩니다. 제거 스크립트는 장기 Key 파일을 휴지통으로 보내지 않고 삭제하지만 서버 Key를 폐기하지는 않습니다. 서버 측 Key 폐기 API는 후속 작업입니다. poll·heartbeat 주기와 상태 디렉터리는 `.env.example`을 참고합니다.

## ECR 보안 경계

Agent는 사용자의 장기 AWS Access Key를 입력으로 받지 않습니다. 서버에서 해당 job에 한정된 ECR 로그인 자격증명을 조회하고 만료 시각, Registry 일치 여부, AWS Region, ECR hostname을 검증합니다. password는 CLI 인자가 아니라 stdin으로만 전달합니다.

성공·실패·취소와 관계없이 `docker logout`을 실행합니다. 이 logout은 로컬 Docker 인증정보를 제거하는 동작이며, 이미 발급된 ECR 토큰 자체를 AWS에서 무효화하지는 않습니다. ECR 토큰은 AWS가 정한 유효기간에 따라 만료됩니다.

Compose 파일에는 환경변수 이름만 기록하고 값은 `docker compose` 프로세스 환경으로 전달합니다. Agent가 만든 project에는 `io.camellia.*` label을 부여하며 실패·취소·교체 시 해당 project만 정리합니다.

## Named Tunnel 보안 경계

원격 관리 Named Tunnel의 Token은 `cloudflared` 명령 인자나 파일에 기록하지 않고 자식 프로세스의 `TUNNEL_TOKEN` 환경변수로만 전달합니다. 등록 토큰과 AWS 자격증명을 포함한 Agent 프로세스의 전체 환경은 상속하지 않습니다. Agent는 loopback metrics `/ready`가 성공해야 Tunnel을 활성 상태로 간주하며, 취소·실패·교체·Agent 종료 시 자신이 시작한 프로세스만 종료합니다.

## macOS Release 설치

Agent 설치기는 Intel Mac(`x86_64`)과 Apple Silicon(`arm64`)을 지원합니다. 특정 Docker 제품에 결합하지 않고 로그인 사용자 세션에서 다음 명령이 동작해야 합니다.

```bash
docker info
docker compose version
cloudflared --version
```

버전을 명시한 다운로드 설치기는 현재 Mac의 아키텍처에 맞는 Release archive와 `.sha256` 파일을 내려받고, 버전·아키텍처·checksum을 검증한 뒤 설치합니다.

```bash
curl -fsSL \
  https://github.com/2026-Softbank-hackerton/Auto-Deployment-System/releases/download/onprem-agent-v0.1.0/install-agent.sh \
  | sh -s -- v0.1.0
```

로컬 build 결과를 직접 설치할 때는 `dist/main.js`와 `dist/launchd-cli.js`를 만든 뒤 bundle 내부 설치기를 실행합니다.

```bash
pnpm --filter @camellia/onprem-agent build
apps/onprem-agent/install/macos/install.sh
```

설치 스크립트는 Agent 파일과 plist를 준비하되 1회용 등록 토큰 입력을 위해 서비스를 자동 시작하지 않습니다. 최초 등록을 마친 뒤 설치된 `camellia-onprem-agent-service start`로 로그인 사용자의 `LaunchAgent`를 활성화합니다. `service.sh`는 `start`, `stop`, `restart`, `status`를 제공하고 `uninstall.sh`는 Agent와 plist를 macOS 휴지통으로 이동하며 로그는 보존합니다.

현재 프로젝트의 애플리케이션 build 계약은 `linux/amd64` 단일 digest입니다. Apple Silicon의 Agent도 같은 digest를 유지하기 위해 Compose에 `platform: linux/amd64`를 명시하며, Docker Desktop의 amd64 에뮬레이션을 사용합니다. Agent 등록·Heartbeat·Job claim·ECR pull·Tunnel·Verify 흐름은 두 Mac 아키텍처에서 동일합니다.

## Agent Release 생성

`package.json` 버전과 일치하는 `onprem-agent-vMAJOR.MINOR.PATCH` tag를 push하면 GitHub Actions가 Agent 테스트·타입체크·린트·build를 수행하고 다음 자산을 Release에 게시합니다.

- `camellia-onprem-agent-vMAJOR.MINOR.PATCH-macos-x64.tar.gz`
- `camellia-onprem-agent-vMAJOR.MINOR.PATCH-macos-arm64.tar.gz`
- archive별 `.sha256`
- `install-agent.sh`

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

실제 Cloudflare 통합 테스트는 플랫폼 API Token, Account·Zone, 테스트 도메인과 현재 OS에서 실행 가능한 `cloudflared`가 준비된 환경에서만 명시적으로 실행합니다. 테스트는 고유한 임시 Named Tunnel과 CNAME을 만들고 동적 `localPort`의 loopback origin이 외부 HTTPS endpoint로 노출되는지 확인한 뒤 생성한 리소스를 정리합니다.

```bash
set -a
source .env.cloudflare.local
set +a
RUN_CLOUDFLARE_INTEGRATION=1 \
CLOUDFLARED_PATH=/absolute/path/to/cloudflared \
pnpm --filter @camellia/onprem-agent test:integration
```

`.env.cloudflare.local`은 저장소의 `.env.*` ignore 규칙에 포함되며 실제 Token을 커밋하거나 테스트 출력에 기록하지 않습니다. Docker와 Cloudflare 실통합을 함께 실행하려면 `RUN_DOCKER_INTEGRATION=1`도 지정합니다.
