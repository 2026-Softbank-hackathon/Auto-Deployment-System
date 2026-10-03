/**
 * apps/api/src/cli/manifest.ts — CLI 명령 목록 (UI-02)
 *
 * CLI(apps/cli)는 실행할 때마다 GET /api/v1/cli/manifest 로 이 목록을 받아 명령을 만든다.
 * 명령은 모두 웹 콘솔이 쓰는 API 를 그대로 부르므로, 여기에 한 줄 추가하면 CLI 를 새로 배포하지 않아도 명령이 생긴다.
 *
 * 템플릿 규칙 (CLI 가 해석)
 *   - path · query · body 의 "{name}" — 인자 값. resolver 로 찾은 인자는 resolver.value 필드, "{app.live.deploymentId}" 처럼 점으로 하위 필드
 *   - body 값이 "$name" 한 덩어리면 타입을 지켜 그대로 넣고, 값이 없으면 그 키를 뺀다
 *   - output.message 의 "{field}" — 응답 필드
 */

export interface CliArg {
  name: string;
  /** 위치 인자 순서 (0부터). 없으면 --flag */
  positional?: number;
  flag?: string;
  type: "string" | "number" | "boolean" | "source";
  required?: boolean;
  enum?: string[];
  description: string;
  /** 이름 · ID 를 resolvers 의 목록에서 찾아 객체로 바꾼다 */
  resolver?: string;
}

export interface CliOutputColumn { key: string; label: string }

export type CliOutput =
  | { kind: "table"; items: string; columns: CliOutputColumn[] }
  | { kind: "object"; fields: CliOutputColumn[] }
  | { kind: "text"; stripPattern?: string }
  | { kind: "message"; text: string }
  | { kind: "none" };

export interface CliCommand {
  /** 공백으로 나눈 명령 이름 (예: "apps list") */
  name: string;
  description: string;
  args: CliArg[];
  request: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
    /** source 인자를 zip 으로 묶어 multipart 로 보낸다 (body 의 각 값은 폼 필드) */
    multipart?: boolean;
  };
  output: CliOutput;
  /** 되돌리기 어려운 명령 — --yes 가 없으면 확인을 받는다 */
  confirm?: string;
  /** 응답의 배포를 끝날 때까지 따라간다 (followers.deployment) */
  follow?: { deployment: string };
}

export interface CliResolver {
  /** 목록 API */
  list: string;
  /** 응답에서 목록 위치 ("" = 응답 자체) */
  items: string;
  /** 사용자가 입력한 값과 비교할 필드 */
  match: string[];
  /** 템플릿 "{name}" 에 들어갈 필드 */
  value: string;
  label: string;
  hint: string;
  /** 값을 주지 않았을 때 고를 항목 */
  defaultWhere?: Record<string, unknown>;
}

export interface CliDeploymentFollower {
  status: string;
  approvals: string;
  intervalMs: number;
  /** 이 상태가 되면 확인 없이 승인 (웹 콘솔의 원클릭과 같다) */
  autoApprove: Record<string, string>;
  /** 이 상태가 되면 사용자에게 묻는다 (--yes 면 승인) */
  ask: Record<string, { gate: string; question: string; detail?: string }>;
  succeeded: string[];
  failed: string[];
  labels: Record<string, string>;
}

export interface CliManifest {
  version: number;
  commands: CliCommand[];
  resolvers: Record<string, CliResolver>;
  followers: { deployment: CliDeploymentFollower };
}

const APP_ARG: CliArg = { name: "app", positional: 0, type: "string", required: true, resolver: "app", description: "앱 이름 · 주소(subdomain) · ID" };
const DEPLOYMENT_ARG: CliArg = { name: "deployment", positional: 0, type: "string", required: true, description: "배포 ID" };

export const CLI_MANIFEST: CliManifest = {
  version: 1,
  resolvers: {
    app: {
      list: "/projects?limit=100", items: "items", match: ["name", "subdomain", "id"], value: "id",
      label: "앱", hint: "camellia apps list 로 이름을 확인하세요.",
    },
    connection: {
      list: "/environments", items: "", match: ["name", "id"], value: "id",
      label: "연결", hint: "camellia connections list 로 이름을 확인하세요.",
      defaultWhere: { type: "aws", isDefault: true },
    },
  },
  followers: {
    deployment: {
      status: "/deployments/{id}",
      approvals: "/deployments/{id}/approvals",
      intervalMs: 2000,
      autoApprove: { awaiting_target_confirmation: "target", awaiting_plan_approval: "plan" },
      ask: {
        awaiting_patch_approval: {
          gate: "patch",
          question: "SQLite 를 PostgreSQL 로 바꾸는 코드 수정안을 적용할까요?",
          detail: "/deployments/{id}/patch",
        },
      },
      succeeded: ["succeeded"],
      failed: ["failed", "cancelled", "rejected"],
      labels: {
        received: "접수", analyzing: "소스 분석", awaiting_patch_approval: "코드 수정안 확인",
        awaiting_target_confirmation: "배포 대상 확인", queued: "대기", building: "이미지 빌드",
        planning: "인프라 계획", awaiting_plan_approval: "인프라 계획 확인", provisioning: "인프라 준비",
        deploying: "배포", verifying: "검증", succeeded: "성공", failed: "실패", cancelled: "취소",
        rejected: "거절", rollback: "되돌리는 중",
      },
    },
  },
  commands: [
    {
      name: "apps list", description: "앱 목록", args: [],
      request: { method: "GET", path: "/projects", query: { limit: "100" } },
      output: {
        kind: "table", items: "items", columns: [
          { key: "id", label: "ID" }, { key: "name", label: "이름" },
          { key: "live.environmentType", label: "서비스 중" }, { key: "latest.status", label: "최근 배포" },
          { key: "publicUrl", label: "주소" },
        ],
      },
    },
    {
      name: "apps get", description: "앱 상세", args: [APP_ARG],
      request: { method: "GET", path: "/projects/{app}" },
      output: {
        kind: "object", fields: [
          { key: "id", label: "ID" }, { key: "name", label: "이름" }, { key: "publicUrl", label: "주소" },
          { key: "deployMode", label: "배포 형태" }, { key: "live.deploymentId", label: "서비스 중인 배포" },
          { key: "live.environmentName", label: "서비스 중인 연결" }, { key: "latest.deploymentId", label: "최근 배포" },
          { key: "latest.status", label: "최근 배포 상태" },
        ],
      },
    },
    {
      name: "apps create", description: "앱 만들기",
      args: [
        { name: "name", positional: 0, type: "string", required: true, description: "앱 이름" },
        { name: "subdomain", flag: "subdomain", type: "string", description: "앱 주소 앞부분 (없으면 service-{ID})" },
      ],
      request: { method: "POST", path: "/projects", body: { name: "$name", subdomain: "$subdomain" } },
      output: { kind: "message", text: "앱 {name} 을(를) 만들었어요. ID {id} · {publicUrl}" },
    },
    {
      name: "apps address", description: "앱 주소 바꾸기",
      args: [APP_ARG, { name: "subdomain", positional: 1, type: "string", required: true, description: "새 주소 앞부분" }],
      request: { method: "PATCH", path: "/projects/{app}/subdomain", body: { subdomain: "$subdomain" } },
      output: { kind: "message", text: "주소를 바꾸고 있어요. 새 주소: {publicUrl}" },
    },
    {
      name: "apps delete", description: "앱 삭제 (만든 인프라 · 주소까지 정리)", args: [APP_ARG],
      request: { method: "DELETE", path: "/projects/{app}" },
      output: { kind: "message", text: "앱 삭제를 시작했어요. 상태: {deletion.status}" },
      confirm: "앱과 앱이 만든 인프라 · 주소를 모두 지웁니다.",
    },
    {
      name: "connections list", description: "배포할 곳(연결) 목록", args: [],
      request: { method: "GET", path: "/environments" },
      output: {
        kind: "table", items: "", columns: [
          { key: "id", label: "ID" }, { key: "name", label: "이름" }, { key: "type", label: "종류" },
          { key: "isDefault", label: "기본" }, { key: "agentOnline", label: "Agent 온라인" },
        ],
      },
    },
    {
      name: "deploy", description: "폴더나 zip 을 올려 배포하고 끝날 때까지 지켜보기",
      args: [
        APP_ARG,
        { name: "source", positional: 1, type: "source", required: true, description: "소스 폴더 또는 .zip" },
        { name: "to", flag: "to", type: "string", resolver: "connection", description: "배포할 연결 (없으면 기본 AWS 연결)" },
        { name: "mode", flag: "mode", type: "string", enum: ["container", "serverless"], description: "배포 형태 (없으면 앱에 저장된 형태)" },
      ],
      request: {
        method: "POST", path: "/deployments", multipart: true,
        body: { source: "$source", project_id: "{app}", environment_id: "{to}", mode: "$mode" },
      },
      output: { kind: "message", text: "배포 {deploymentId} 를 시작했어요." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "switch", description: "서비스 중인 버전을 다른 연결로 옮기기 (빌드 없이 같은 이미지)",
      args: [APP_ARG, { name: "to", flag: "to", type: "string", required: true, resolver: "connection", description: "옮겨 갈 연결" }],
      request: { method: "POST", path: "/deployments/{app.live.deploymentId}/redeploy", body: { targetEnvironmentId: "{to}" } },
      output: { kind: "message", text: "배포 {deploymentId} 로 옮기고 있어요." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "redeploy", description: "이전 배포의 이미지로 다시 배포 (롤백에도 씀)",
      args: [DEPLOYMENT_ARG, { name: "to", flag: "to", type: "string", resolver: "connection", description: "다른 연결로 배포할 때" }],
      request: { method: "POST", path: "/deployments/{deployment}/redeploy", body: { targetEnvironmentId: "{to}" } },
      output: { kind: "message", text: "배포 {deploymentId} 를 시작했어요." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "deployments", description: "앱의 배포 내역",
      args: [APP_ARG, { name: "limit", flag: "limit", type: "number", description: "최대 개수 (기본 20)" }],
      request: { method: "GET", path: "/projects/{app}/deployments", query: { limit: "{limit}" } },
      output: {
        kind: "table", items: "items", columns: [
          { key: "id", label: "ID" }, { key: "status", label: "상태" }, { key: "environmentName", label: "연결" },
          { key: "targetProfile", label: "프로필" }, { key: "isLive", label: "서비스 중" }, { key: "createdAt", label: "시각" },
        ],
      },
    },
    {
      name: "status", description: "배포 상태", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}" },
      output: {
        kind: "object", fields: [
          { key: "id", label: "ID" }, { key: "status", label: "상태" }, { key: "targetProfile", label: "프로필" },
          { key: "publicUrl", label: "주소" }, { key: "error", label: "오류" }, { key: "createdAt", label: "시작" },
          { key: "succeededAt", label: "성공" }, { key: "failedAt", label: "실패" },
        ],
      },
    },
    {
      name: "logs", description: "배포 단계 로그",
      args: [
        DEPLOYMENT_ARG,
        { name: "step", flag: "step", type: "string", enum: ["analyze", "build", "provision", "verify"], description: "단계 (기본 provision)" },
        { name: "tail", flag: "tail", type: "number", description: "마지막 N줄" },
      ],
      request: { method: "GET", path: "/deployments/{deployment}/logs", query: { step: "{step}", tail: "{tail}" } },
      // 로그 줄 끝의 화면 번역용 꼬리표(#307)는 터미널에서 뺀다
      output: { kind: "text", stripPattern: "\\s*#i18n\\{.*\\}\\s*$" },
    },
    {
      name: "diagnosis", description: "실패한 배포의 AI 진단", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}/diagnosis" },
      output: { kind: "object", fields: [{ key: "failedStep", label: "실패 단계" }, { key: "summary", label: "원인" }, { key: "generatedAt", label: "진단 시각" }] },
    },
    {
      name: "cost", description: "월 예상 인프라 비용", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}/cost-estimate" },
      output: {
        kind: "table", items: "estimate.items", columns: [
          { key: "key", label: "항목" }, { key: "monthlyUsd", label: "월 USD" }, { key: "usageBased", label: "쓰는 만큼" },
        ],
      },
    },
    {
      name: "cancel", description: "진행 중인 배포 취소", args: [DEPLOYMENT_ARG],
      request: { method: "POST", path: "/deployments/{deployment}/cancel" },
      output: { kind: "message", text: "배포를 취소했어요." },
      confirm: "진행 중인 배포를 멈춥니다.",
    },
    {
      name: "env list", description: "앱 환경변수 (값은 가려서 보여 줌)", args: [APP_ARG],
      request: { method: "GET", path: "/projects/{app}/env" },
      output: { kind: "table", items: "items", columns: [{ key: "name", label: "이름" }, { key: "updatedAt", label: "바꾼 시각" }] },
    },
    {
      name: "env set", description: "환경변수 넣기 (다음 배포부터 적용)",
      args: [
        APP_ARG,
        { name: "key", positional: 1, type: "string", required: true, description: "이름" },
        { name: "value", positional: 2, type: "string", required: true, description: "값" },
      ],
      request: { method: "PATCH", path: "/projects/{app}/env", body: { vars: { "{key}": "$value" } } },
      output: { kind: "message", text: "환경변수를 저장했어요. 다음 배포부터 적용돼요." },
    },
    {
      name: "env unset", description: "환경변수 지우기",
      args: [APP_ARG, { name: "key", positional: 1, type: "string", required: true, description: "이름" }],
      request: { method: "PATCH", path: "/projects/{app}/env", body: { vars: { "{key}": null } } },
      output: { kind: "message", text: "환경변수를 지웠어요." },
    },
  ],
};
