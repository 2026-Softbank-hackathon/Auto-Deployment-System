# @camellia/contracts

camellia API(`/api/v1`)의 요청 · 응답 · SSE 이벤트 계약. Zod 스키마와 TS 타입을 같이 export 합니다.
백엔드(`apps/api`, `apps/worker`)가 이 패키지를 그대로 쓰기 때문에, 여기 타입이 곧 API가 실제로 주고받는 형태입니다.

> **규칙: API 응답을 바꾸면 계약도 같이 바꾼다.**
> 서비스 DTO 반환 타입이 계약 타입이라 어긋나면 `tsc`가, 실제 라우트 응답이 어긋나면
> `apps/api/tests/contracts.test.ts`(mock DB) · `tests/e2e/contracts.test.ts`(실제 Postgres)가 막습니다.

## 쓰는 법

프론트 패키지(예: `apps/web`)의 `package.json`에 추가하고 루트에서 `pnpm install`.

```json
{
  "dependencies": {
    "@camellia/contracts": "workspace:*"
  }
}
```

빌드 없이 TS 소스(`src/index.ts`)를 그대로 export 합니다. Vite는 그대로 동작하고, Next.js라면 `transpilePackages: ["@camellia/contracts"]`가 필요합니다.

## 구성

| 파일 | 내용 |
|---|---|
| `common.ts` | 에러 바디, ID · 날짜, 배포 상태(`DeploymentStatus`), 대상 프로필, 승인 게이트 |
| `projects.ts` | `/projects` — 생성 · 목록 · 조회 · 배포 이력 |
| `env.ts` | `/projects/:id/env` — 환경변수 |
| `deployments.ts` | `/deployments` — 업로드 · 조회 · IR · 누락 리소스 · 승인 · 분석 리포트 · 로그 · 헬스 · 진단 · AI 사용량 |
| `secrets.ts` · `environments.ts` | `/secrets` · `/environments` |
| `events.ts` | `GET /deployments/:id/events` SSE 이벤트 |
| `ops.ts` | `/ops` — 플랫폼 운영 화면(작업 큐 · 워커 · 서버 지표 · AI 비용 추정 · 자동 배포 기록) |

이름 규칙: 요청은 `XxxBodySchema` / `XxxQuerySchema`(타입은 보내는 형태 `z.input`), 응답은 `XxxSchema` + 같은 이름의 타입(`Deployment`, `Project` …).

## 예시

### fetch

```ts
import {
  DeploymentSchema,
  type Deployment,
  type ErrorBody,
  type SubmitApprovalBody,
  type SubmitApprovalResponse,
} from "@camellia/contracts";

async function getDeployment(id: string): Promise<Deployment> {
  const res = await fetch(`/api/v1/deployments/${id}`);
  if (!res.ok) throw (await res.json()) as ErrorBody; // { error: { code, message, hint? }, requestId }
  return (await res.json()) as Deployment;
  // 런타임 검증까지 하려면: return DeploymentSchema.parse(await res.json());
}

async function approveTarget(id: string): Promise<SubmitApprovalResponse> {
  const body: SubmitApprovalBody = { gate: "target", decision: "approve" };
  const res = await fetch(`/api/v1/deployments/${id}/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
```

### SSE (EventSource)

```ts
import type { DeploymentEventData } from "@camellia/contracts";

const es = new EventSource(`/api/v1/deployments/${id}/events`);

es.addEventListener("log.line", (e) => {
  const data: DeploymentEventData<"log.line"> = JSON.parse((e as MessageEvent).data);
  appendLog(data.step, data.line);
});

es.addEventListener("state_changed", (e) => {
  const data: DeploymentEventData<"state_changed"> = JSON.parse((e as MessageEvent).data);
  // 워커는 { status }, 승인 API 는 { deploymentId, from, to, reason? } 로 보낸다
  setStatus("status" in data ? data.status : data.to);
});
```

이벤트: `state_changed` · `analysis.progress` · `approval_requested` · `log.line` · `ir_updated` · `missing_resources_updated` (`DEPLOYMENT_EVENT_NAMES`).
30초마다 오는 `: heartbeat`는 SSE 주석이라 EventSource 이벤트로 오지 않습니다.

## 지금 API 의 주의할 점

계약은 현재 동작을 그대로 옮긴 것이라, 아래 불일치도 타입에 그대로 들어 있습니다.

- ID 표현이 섞여 있음 — projects · deployments 계열은 문자열(`"42"`), analysis-report · diagnosis · ai-usage 의 `deploymentId`는 number.
- environments 의 `id` · `projectId`, secrets 의 `projectId`, IR `version` 은 `number | string` (`PgBigIntSchema`). DB 에서 읽은 BIGINT 를 pg 드라이버가 문자열로 줘서 응답마다 다릅니다. 쓸 때 `Number(x)` / `String(x)`로 맞추세요.
- `GET /deployments/:id/logs` 는 JSON 이 아니라 `text/plain` 문자열, 로그가 없으면 `204`(빈 바디). `DELETE` 는 `204`.
- `GET /projects` 의 `total` 은 전체 개수가 아니라 이번 페이지 `items` 개수.
