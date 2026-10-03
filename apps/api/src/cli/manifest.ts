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

const APP_ARG: CliArg = { name: "app", positional: 0, type: "string", required: true, resolver: "app", description: "App name, subdomain, or ID" };
const DEPLOYMENT_ARG: CliArg = { name: "deployment", positional: 0, type: "string", required: true, description: "Deployment ID" };

export const CLI_MANIFEST: CliManifest = {
  version: 1,
  resolvers: {
    app: {
      list: "/projects?limit=100", items: "items", match: ["name", "subdomain", "id"], value: "id",
      label: "App", hint: "Run camellia apps list to see app names.",
    },
    connection: {
      list: "/environments", items: "", match: ["name", "id"], value: "id",
      label: "Connection", hint: "Run camellia connections list to see connection names.",
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
          question: "Apply the suggested code change that moves SQLite to PostgreSQL?",
          detail: "/deployments/{id}/patch",
        },
      },
      succeeded: ["succeeded"],
      failed: ["failed", "cancelled", "rejected"],
      labels: {
        received: "Received", analyzing: "Analyzing source", awaiting_patch_approval: "Waiting for code change approval",
        awaiting_target_confirmation: "Confirming target", queued: "Queued", building: "Building image",
        planning: "Planning infrastructure", awaiting_plan_approval: "Approving plan", provisioning: "Provisioning infrastructure",
        deploying: "Deploying", verifying: "Verifying", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled",
        rejected: "Rejected", rollback: "Rolling back",
      },
    },
  },
  commands: [
    {
      name: "apps list", description: "List apps", args: [],
      request: { method: "GET", path: "/projects", query: { limit: "100" } },
      output: {
        kind: "table", items: "items", columns: [
          { key: "id", label: "ID" }, { key: "name", label: "NAME" },
          { key: "live.environmentType", label: "LIVE ON" }, { key: "latest.status", label: "LATEST" },
          { key: "publicUrl", label: "URL" },
        ],
      },
    },
    {
      name: "apps get", description: "Show an app", args: [APP_ARG],
      request: { method: "GET", path: "/projects/{app}" },
      output: {
        kind: "object", fields: [
          { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "publicUrl", label: "URL" },
          { key: "deployMode", label: "Mode" }, { key: "live.deploymentId", label: "Live deployment" },
          { key: "live.environmentName", label: "Live on" }, { key: "latest.deploymentId", label: "Latest deployment" },
          { key: "latest.status", label: "Latest status" },
        ],
      },
    },
    {
      name: "apps create", description: "Create an app",
      args: [
        { name: "name", positional: 0, type: "string", required: true, description: "App name" },
        { name: "subdomain", flag: "subdomain", type: "string", description: "Subdomain for the app URL (default service-{ID})" },
      ],
      request: { method: "POST", path: "/projects", body: { name: "$name", subdomain: "$subdomain" } },
      output: { kind: "message", text: "Created app {name} (ID {id}) at {publicUrl}" },
    },
    {
      name: "apps address", description: "Change the app URL",
      args: [APP_ARG, { name: "subdomain", positional: 1, type: "string", required: true, description: "New subdomain" }],
      request: { method: "PATCH", path: "/projects/{app}/subdomain", body: { subdomain: "$subdomain" } },
      output: { kind: "message", text: "Changing the URL. New URL: {publicUrl}" },
    },
    {
      name: "apps delete", description: "Delete an app with its infrastructure and URL", args: [APP_ARG],
      request: { method: "DELETE", path: "/projects/{app}" },
      output: { kind: "message", text: "Deleting the app. Status: {deletion.status}" },
      confirm: "This deletes the app, its infrastructure and its URL.",
    },
    {
      name: "connections list", description: "List deploy targets (connections)", args: [],
      request: { method: "GET", path: "/environments" },
      output: {
        kind: "table", items: "", columns: [
          { key: "id", label: "ID" }, { key: "name", label: "NAME" }, { key: "type", label: "TYPE" },
          { key: "isDefault", label: "DEFAULT" }, { key: "agentOnline", label: "AGENT ONLINE" },
        ],
      },
    },
    {
      name: "deploy", description: "Upload a folder or zip, deploy it and watch until it finishes",
      args: [
        APP_ARG,
        { name: "source", positional: 1, type: "source", required: true, description: "Source folder or .zip" },
        { name: "to", flag: "to", type: "string", resolver: "connection", description: "Connection to deploy to (default: the default AWS connection)" },
        { name: "mode", flag: "mode", type: "string", enum: ["container", "serverless"], description: "Deploy mode (default: the mode saved on the app)" },
      ],
      request: {
        method: "POST", path: "/deployments", multipart: true,
        body: { source: "$source", project_id: "{app}", environment_id: "{to}", mode: "$mode" },
      },
      output: { kind: "message", text: "Started deployment {deploymentId}." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "switch", description: "Move the live version to another connection (same image, no rebuild)",
      args: [APP_ARG, { name: "to", flag: "to", type: "string", required: true, resolver: "connection", description: "Connection to move to" }],
      request: { method: "POST", path: "/deployments/{app.live.deploymentId}/redeploy", body: { targetEnvironmentId: "{to}" } },
      output: { kind: "message", text: "Moving with deployment {deploymentId}." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "redeploy", description: "Redeploy the image of a past deployment (also for rollback)",
      args: [DEPLOYMENT_ARG, { name: "to", flag: "to", type: "string", resolver: "connection", description: "Deploy to another connection" }],
      request: { method: "POST", path: "/deployments/{deployment}/redeploy", body: { targetEnvironmentId: "{to}" } },
      output: { kind: "message", text: "Started deployment {deploymentId}." },
      follow: { deployment: "deploymentId" },
    },
    {
      name: "deployments", description: "List deployments of an app",
      args: [APP_ARG, { name: "limit", flag: "limit", type: "number", description: "Max rows (default 20)" }],
      request: { method: "GET", path: "/projects/{app}/deployments", query: { limit: "{limit}" } },
      output: {
        kind: "table", items: "items", columns: [
          { key: "id", label: "ID" }, { key: "status", label: "STATUS" }, { key: "environmentName", label: "CONNECTION" },
          { key: "targetProfile", label: "PROFILE" }, { key: "isLive", label: "LIVE" }, { key: "createdAt", label: "CREATED" },
        ],
      },
    },
    {
      name: "status", description: "Show a deployment", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}" },
      output: {
        kind: "object", fields: [
          { key: "id", label: "ID" }, { key: "status", label: "Status" }, { key: "targetProfile", label: "Profile" },
          { key: "publicUrl", label: "URL" }, { key: "error", label: "Error" }, { key: "createdAt", label: "Created" },
          { key: "succeededAt", label: "Succeeded" }, { key: "failedAt", label: "Failed" },
        ],
      },
    },
    {
      name: "logs", description: "Show the log of a deployment step",
      args: [
        DEPLOYMENT_ARG,
        { name: "step", flag: "step", type: "string", enum: ["analyze", "build", "provision", "verify"], description: "Step (default provision)" },
        { name: "tail", flag: "tail", type: "number", description: "Last N lines" },
      ],
      request: { method: "GET", path: "/deployments/{deployment}/logs", query: { step: "{step}", tail: "{tail}" } },
      // 로그 줄 끝의 화면 번역용 꼬리표(#307)는 터미널에서 뺀다
      output: { kind: "text", stripPattern: "\\s*#i18n\\{.*\\}\\s*$" },
    },
    {
      name: "diagnosis", description: "AI diagnosis of a failed deployment", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}/diagnosis" },
      output: { kind: "object", fields: [{ key: "failedStep", label: "Failed step" }, { key: "summary", label: "Cause" }, { key: "generatedAt", label: "Diagnosed at" }] },
    },
    {
      name: "cost", description: "Estimated monthly infrastructure cost", args: [DEPLOYMENT_ARG],
      request: { method: "GET", path: "/deployments/{deployment}/cost-estimate" },
      output: {
        kind: "table", items: "estimate.items", columns: [
          { key: "key", label: "ITEM" }, { key: "monthlyUsd", label: "USD/MONTH" }, { key: "usageBased", label: "USAGE-BASED" },
        ],
      },
    },
    {
      name: "cancel", description: "Cancel a running deployment", args: [DEPLOYMENT_ARG],
      request: { method: "POST", path: "/deployments/{deployment}/cancel" },
      output: { kind: "message", text: "Deployment cancelled." },
      confirm: "This stops the running deployment.",
    },
    {
      name: "env list", description: "List app environment variables (values hidden)", args: [APP_ARG],
      request: { method: "GET", path: "/projects/{app}/env" },
      output: { kind: "table", items: "items", columns: [{ key: "name", label: "NAME" }, { key: "updatedAt", label: "UPDATED" }] },
    },
    {
      name: "env set", description: "Set an environment variable (applies from the next deployment)",
      args: [
        APP_ARG,
        { name: "key", positional: 1, type: "string", required: true, description: "Name" },
        { name: "value", positional: 2, type: "string", required: true, description: "Value" },
      ],
      request: { method: "PATCH", path: "/projects/{app}/env", body: { vars: { "{key}": "$value" } } },
      output: { kind: "message", text: "Saved. It applies from the next deployment." },
    },
    {
      name: "env unset", description: "Remove an environment variable",
      args: [APP_ARG, { name: "key", positional: 1, type: "string", required: true, description: "Name" }],
      request: { method: "PATCH", path: "/projects/{app}/env", body: { vars: { "{key}": null } } },
      output: { kind: "message", text: "Removed." },
    },
  ],
};
