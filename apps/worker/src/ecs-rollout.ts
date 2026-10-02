/**
 * apps/worker/src/ecs-rollout.ts
 *
 * Terraform apply 뒤 ECS 롤아웃이 끝날 때까지 기다린다 (#253).
 * aws-ecs-basic 프로필은 wait_for_steady_state 를 끄고, 대신 워커가 2초마다 ECS 를 확인한다.
 * 이전 태스크 드레이닝 · 정지까지 기다리던 Terraform 과 달리, 새 태스크가 타깃 그룹에서
 * healthy 가 되면 바로 끝낸다 (그 시점부터 ALB 가 새 버전으로 보낸다). 순서는 그대로
 * "롤아웃 완료 → 최종 검증(Verify)".
 *
 * 완료: 이번 task definition의 배포가 rolloutState COMPLETED, 또는 그 배포의 running 수가 desired 에
 *       닿고 그 태스크들이 모두 타깃 그룹에서 healthy.
 * 실패: 배포 rolloutState FAILED(회로 차단기 롤백) · 새 태스크 중지(stoppedReason) · 제한 시간.
 * Provision 이 쓰는 자격 증명(대상 연결의 AWS 키)을 그대로 쓴다.
 */

import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  type Deployment,
  type Service,
  type Task,
} from "@aws-sdk/client-ecs";
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  type TargetHealthDescription,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import type { TerraformAwsCredentials } from "./terraform-cli.js";
import { formatLogText, logMessage, renderLogText, type LogMessage, type LogText } from "./log-messages.js";

export type EcsRolloutErrorCode =
  | "ECS_SERVICE_NOT_FOUND"
  | "ECS_ROLLOUT_FAILED"
  | "ECS_TASK_STOPPED"
  | "ECS_ROLLOUT_TIMEOUT"
  | "ECS_ROLLOUT_CHECK_FAILED";

export class EcsRolloutError extends Error {
  constructor(
    readonly code: EcsRolloutErrorCode,
    readonly detail: string,
  ) {
    super(code);
    this.name = "EcsRolloutError";
  }
}

export type EcsRolloutInput = {
  region: string;
  credentials: TerraformAwsCredentials;
  clusterName: string;
  serviceName: string;
  /** 이번 Terraform apply가 생성한 정확한 task definition ARN */
  expectedTaskDefinition: string;
  log: (line: LogText) => Promise<void>;
};

type SendClient = { send(command: unknown): Promise<unknown> };
export type EcsRolloutClients = { ecs: SendClient; elb: SendClient };

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10 * 60 * 1000;
/** 상태가 그대로여도 이 간격마다 대기 중임을 남긴다 */
const HEARTBEAT_MS = 30_000;

export class EcsRolloutWaiter {
  private readonly createClients: (region: string, credentials: TerraformAwsCredentials) => EcsRolloutClients;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: {
    createClients?: (region: string, credentials: TerraformAwsCredentials) => EcsRolloutClients;
    pollIntervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {}) {
    this.createClients = options.createClients ?? ((region, credentials) => ({
      ecs: new ECSClient({ region, credentials }) as SendClient,
      elb: new ElasticLoadBalancingV2Client({ region, credentials }) as SendClient,
    }));
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async wait(input: EcsRolloutInput): Promise<void> {
    try {
      await this.poll(input);
    } catch (error) {
      if (error instanceof EcsRolloutError) throw error;
      const name = (error as { name?: unknown } | null)?.name;
      const message = error instanceof Error ? error.message : String(error);
      throw new EcsRolloutError(
        "ECS_ROLLOUT_CHECK_FAILED",
        `ECS 롤아웃 상태를 조회하지 못했습니다: ${typeof name === "string" ? `${name}: ` : ""}${message}`,
      );
    }
  }

  private async poll(input: EcsRolloutInput): Promise<void> {
    const { ecs, elb } = this.createClients(input.region, input.credentials);
    const cluster = input.clusterName;
    const startedAt = this.now();
    const lastLines = new Map<string, string>();
    let lastWriteAt = startedAt;
    let trackedId: string | undefined;
    let lastUnhealthy: string | undefined;

    const write = async (slot: string, line: LogMessage) => {
      const text = formatLogText(line);
      if (lastLines.get(slot) === text) return;
      lastLines.set(slot, text);
      lastWriteAt = this.now();
      await input.log(line);
    };
    const elapsed = () => Math.round((this.now() - startedAt) / 1000);

    const tasksOf = async (deployment: Deployment, desiredStatus: "RUNNING" | "STOPPED"): Promise<Task[]> => {
      const listed = (await ecs.send(
        new ListTasksCommand({ cluster, serviceName: input.serviceName, desiredStatus }),
      )) as { taskArns?: string[] };
      const arns = listed.taskArns ?? [];
      if (arns.length === 0) return [];
      const described = (await ecs.send(
        new DescribeTasksCommand({ cluster, tasks: arns }),
      )) as { tasks?: Task[] };
      return (described.tasks ?? []).filter((task) => belongsTo(task, deployment));
    };

    await input.log(
      logMessage("ecs.start", { service: input.serviceName, interval: this.pollIntervalMs / 1000 }),
    );

    for (;;) {
      const described = (await ecs.send(
        new DescribeServicesCommand({ cluster, services: [input.serviceName] }),
      )) as { services?: Service[] };
      const service = described.services?.[0];
      if (!service) {
        throw new EcsRolloutError(
          "ECS_SERVICE_NOT_FOUND",
          `ECS 서비스 ${cluster}/${input.serviceName} 를 찾지 못했습니다.`,
        );
      }
      const deployments = service.deployments ?? [];

      if (!trackedId) {
        trackedId = findDeployment(deployments, input.expectedTaskDefinition);
        if (!trackedId) {
          throw new EcsRolloutError(
            "ECS_ROLLOUT_FAILED",
            withEvent(
              "이번 task definition으로 시작한 ECS 배포를 찾지 못했습니다. 이미 이전 버전으로 롤백된 것으로 보입니다.",
              service,
            ),
          );
        }
      }

      const deployment = deployments.find((candidate) => candidate.id === trackedId);
      if (!deployment || deployment.rolloutState === "FAILED" || deployment.status !== "PRIMARY") {
        const stopped = deployment ? await tasksOf(deployment, "STOPPED").catch(() => []) : [];
        const reason = deployment?.rolloutStateReason
          ? `ECS 배포가 실패해 이전 버전으로 롤백됩니다: ${deployment.rolloutStateReason}`
          : "ECS 배포가 실패해 이전 버전으로 롤백되었습니다.";
        throw new EcsRolloutError(
          "ECS_ROLLOUT_FAILED",
          withEvent(
            [reason, ...stopped.slice(0, 1).flatMap(describeStoppedTask)].join("\n"),
            service,
            deployment?.createdAt,
          ),
        );
      }

      if (deployment.rolloutState === "COMPLETED") {
        await input.log(logMessage("ecs.doneDeployment", { seconds: elapsed() }));
        return;
      }

      const desired = deployment.desiredCount ?? 0;
      const running = await tasksOf(deployment, "RUNNING");
      const targetGroupArn = service.loadBalancers?.[0]?.targetGroupArn;
      const targets = targetGroupArn
        ? (((await elb.send(
            new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn }),
          )) as { TargetHealthDescriptions?: TargetHealthDescription[] }).TargetHealthDescriptions ?? [])
        : [];
      const ownTargets = running
        .map((task) => taskIp(task))
        .filter((ip): ip is string => Boolean(ip))
        .map((ip) => targets.find((target) => target.Target?.Id === ip))
        .filter((target): target is TargetHealthDescription => Boolean(target));
      const healthy = ownTargets.filter((target) => target.TargetHealth?.State === "healthy").length;
      const unhealthy = ownTargets.find((target) => target.TargetHealth?.State === "unhealthy");
      if (unhealthy) {
        lastUnhealthy = unhealthy.TargetHealth?.Description ?? unhealthy.TargetHealth?.Reason ?? lastUnhealthy;
      }

      const runningCount = running.filter((task) => task.lastStatus === "RUNNING").length;
      const taskLine = running.length === 0
        ? logMessage("ecs.taskPlacing", { desired })
        : runningCount < running.length
          ? logMessage("ecs.taskStarting", {
              states: running.map((task) => task.lastStatus ?? "?").join(", "),
              running: runningCount,
              desired,
            })
          : logMessage("ecs.taskRunning", { running: runningCount, desired });
      await write("task", taskLine);

      let targetLine: LogMessage | undefined;
      if (targetGroupArn && ownTargets.length > 0) {
        targetLine = unhealthy
          ? logMessage("ecs.healthFailing", { reason: lastUnhealthy ?? "unhealthy", healthy, desired })
          : healthy >= desired && desired > 0
            ? logMessage("ecs.healthPassed", { healthy, desired })
            : logMessage("ecs.healthChecking", { healthy, desired });
        await write("target", targetLine);
      }

      if (targetGroupArn && desired > 0 && runningCount >= desired && healthy >= desired) {
        await input.log(logMessage("ecs.doneHealthy", { seconds: elapsed() }));
        return;
      }

      const stopped = await tasksOf(deployment, "STOPPED");
      if (stopped.length > 0) {
        const lines = describeStoppedTask(stopped[0]!);
        if (lastUnhealthy) lines.push(`타깃 그룹 헬스체크: ${lastUnhealthy}`);
        throw new EcsRolloutError(
          "ECS_TASK_STOPPED",
          withEvent(lines.join("\n"), service, deployment.createdAt),
        );
      }

      if (this.now() - startedAt >= this.timeoutMs) {
        const lastState = [taskLine, targetLine]
          .flatMap((line) => (line ? [renderLogText(line)] : []))
          .join(" · ");
        throw new EcsRolloutError(
          "ECS_ROLLOUT_TIMEOUT",
          withEvent(
            `ECS 롤아웃이 ${Math.round(this.timeoutMs / 60_000)}분 안에 끝나지 않았습니다. 마지막 상태: ${lastState}`,
            service,
            deployment.createdAt,
          ),
        );
      }

      if (this.now() - lastWriteAt >= HEARTBEAT_MS) {
        lastWriteAt = this.now();
        await input.log(logMessage("ecs.waiting", { seconds: elapsed() }));
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}

/** PRIMARY 배포부터 보고, 이번 Terraform apply가 만든 task definition의 배포 id를 찾는다 */
function findDeployment(
  deployments: Deployment[],
  expectedTaskDefinition: string,
): string | undefined {
  const ordered = [...deployments].sort(
    (a, b) => Number(b.status === "PRIMARY") - Number(a.status === "PRIMARY"),
  );
  for (const deployment of ordered) {
    if (!deployment.id || !deployment.taskDefinition) continue;
    if (deployment.taskDefinition === expectedTaskDefinition) return deployment.id;
  }
  return undefined;
}

/** 이 배포가 띄운 태스크인지 — 같은 태스크 정의이고 배포 이후에 만들어진 것 */
function belongsTo(task: Task, deployment: Deployment): boolean {
  if (task.taskDefinitionArn !== deployment.taskDefinition) return false;
  if (task.createdAt && deployment.createdAt) {
    return new Date(task.createdAt).getTime() >= new Date(deployment.createdAt).getTime();
  }
  return true;
}

function taskIp(task: Task): string | undefined {
  for (const attachment of task.attachments ?? []) {
    const ip = attachment.details?.find((detail) => detail.name === "privateIPv4Address")?.value;
    if (ip) return ip;
  }
  return undefined;
}

function describeStoppedTask(task: Task): string[] {
  const lines = [`새 태스크가 중지되었습니다: ${task.stoppedReason ?? task.stopCode ?? "이유 없음"}`];
  for (const container of task.containers ?? []) {
    if (container.exitCode === undefined && !container.reason) continue;
    const exit = container.exitCode !== undefined ? `종료 코드 ${container.exitCode}` : "종료";
    lines.push(`컨테이너 ${container.name ?? "?"}: ${exit}${container.reason ? ` (${container.reason})` : ""}`);
  }
  return lines;
}

/** 이번 배포 이후의 가장 최근 ECS 서비스 이벤트를 붙인다 — 배치 실패 · 롤백 같은 이유가 여기에 남는다 */
function withEvent(text: string, service: Service, since?: Date): string {
  const sinceMs = since ? new Date(since).getTime() : 0;
  const latest = [...(service.events ?? [])]
    .filter((event) => event.message && new Date(event.createdAt ?? 0).getTime() >= sinceMs)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  return latest ? `${text}\nECS 이벤트: ${latest.message}` : text;
}
