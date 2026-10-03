import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import { DeregisterTargetsCommand, DescribeTargetHealthCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { describe, expect, it, vi } from "vitest";
import { EcsRolloutError, EcsRolloutWaiter } from "../src/ecs-rollout.js";
import { renderLogText, type LogText } from "../src/log-messages.js";

const NEW_TD = "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/cam-x:8";
const OLD_TD = "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/cam-x:7";
const TG = "arn:aws:elasticloadbalancing:ap-northeast-2:123456789012:targetgroup/cam-x-tg/abc";
const DEPLOYED_AT = new Date("2026-10-02T00:00:00Z");

type Deployment = {
  id: string;
  status: "PRIMARY" | "ACTIVE";
  taskDefinition: string;
  desiredCount: number;
  runningCount: number;
  pendingCount: number;
  rolloutState: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  rolloutStateReason?: string;
  createdAt: Date;
};

type Task = {
  taskArn: string;
  taskDefinitionArn: string;
  lastStatus: string;
  desiredStatus: string;
  createdAt: Date;
  ip?: string;
  stoppedReason?: string;
  containers?: Array<{ name: string; exitCode?: number; reason?: string }>;
};

type Snapshot = {
  deployments: Deployment[];
  tasks?: Task[];
  targets?: Array<{ ip: string; state: string; description?: string }>;
  events?: Array<{ message: string; createdAt: Date }>;
};

const newDeployment = (patch: Partial<Deployment> = {}): Deployment => ({
  id: "ecs-svc/new",
  status: "PRIMARY",
  taskDefinition: NEW_TD,
  desiredCount: 1,
  runningCount: 0,
  pendingCount: 0,
  rolloutState: "IN_PROGRESS",
  createdAt: DEPLOYED_AT,
  ...patch,
});

const oldDeployment = (patch: Partial<Deployment> = {}): Deployment => ({
  id: "ecs-svc/old",
  status: "ACTIVE",
  taskDefinition: OLD_TD,
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  rolloutState: "COMPLETED",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...patch,
});

const newTask = (patch: Partial<Task> = {}): Task => ({
  taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/cam-x/new1",
  taskDefinitionArn: NEW_TD,
  lastStatus: "RUNNING",
  desiredStatus: "RUNNING",
  createdAt: new Date("2026-10-02T00:00:05Z"),
  ip: "10.0.1.20",
  ...patch,
});

const oldTask: Task = {
  taskArn: "arn:aws:ecs:ap-northeast-2:123456789012:task/cam-x/old1",
  taskDefinitionArn: OLD_TD,
  lastStatus: "RUNNING",
  desiredStatus: "RUNNING",
  createdAt: new Date("2026-10-01T00:00:05Z"),
  ip: "10.0.0.10",
};

/** 폴링 회차(DescribeServices 호출)마다 snapshots 를 하나씩 넘기는 가짜 ECS · ELB */
function fakeAws(snapshots: Snapshot[]) {
  let index = -1;
  const current = () => snapshots[Math.min(index, snapshots.length - 1)]!;
  const toAwsTask = (task: Task) => ({
    taskArn: task.taskArn,
    taskDefinitionArn: task.taskDefinitionArn,
    lastStatus: task.lastStatus,
    desiredStatus: task.desiredStatus,
    createdAt: task.createdAt,
    stoppedReason: task.stoppedReason,
    containers: task.containers,
    attachments: task.ip
      ? [{
          type: "ElasticNetworkInterface",
          details: [{ name: "privateIPv4Address", value: task.ip }],
        }]
      : [],
  });
  const ecsSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeServicesCommand) {
      index += 1;
      const snapshot = current();
      return {
        services: [{
          serviceName: "cam-x",
          deployments: snapshot.deployments,
          loadBalancers: [{ targetGroupArn: TG, containerName: "demo", containerPort: 3000 }],
          events: snapshot.events ?? [],
        }],
      };
    }
    if (command instanceof ListTasksCommand) {
      const wanted = command.input.desiredStatus;
      return {
        taskArns: (current().tasks ?? [])
          .filter((task) => task.desiredStatus === wanted)
          .map((task) => task.taskArn),
      };
    }
    if (command instanceof DescribeTasksCommand) {
      const arns = command.input.tasks ?? [];
      return {
        tasks: (current().tasks ?? []).filter((task) => arns.includes(task.taskArn)).map(toAwsTask),
      };
    }
    throw new Error(`unexpected ECS command ${String(command)}`);
  });
  const deregistered: (string | undefined)[] = [];
  const elbSend = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeTargetHealthCommand) {
      expect(command.input.TargetGroupArn).toBe(TG);
      return {
        TargetHealthDescriptions: (current().targets ?? []).map((target) => ({
          Target: { Id: target.ip, Port: 3000 },
          TargetHealth: { State: target.state, Description: target.description },
        })),
      };
    }
    if (command instanceof DeregisterTargetsCommand) {
      expect(command.input.TargetGroupArn).toBe(TG);
      deregistered.push(...(command.input.Targets ?? []).map((target) => target.Id));
      return {};
    }
    throw new Error(`unexpected ELB command ${String(command)}`);
  });
  return { ecsSend, elbSend, polls: () => index + 1, deregistered };
}

function makeWaiter(
  snapshots: Snapshot[],
  options: {
    timeoutMs?: number;
  } = {},
) {
  const aws = fakeAws(snapshots);
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const createClients = vi.fn(() => ({
    ecs: { send: aws.ecsSend },
    elb: { send: aws.elbSend },
  }));
  const waiter = new EcsRolloutWaiter({
    createClients: createClients as never,
    sleep,
    now: () => clock,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const lines: string[] = [];
  const input = {
    region: "ap-northeast-2",
    credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    clusterName: "cam-x",
    serviceName: "cam-x",
    expectedTaskDefinition: NEW_TD,
    log: vi.fn(async (line: LogText) => {
      lines.push(renderLogText(line));
    }),
  };
  return { waiter, aws, sleep, createClients, input, lines };
}

async function captureError(promise: Promise<unknown>): Promise<EcsRolloutError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EcsRolloutError);
    return error as EcsRolloutError;
  }
  throw new Error("expected EcsRolloutError");
}

describe("EcsRolloutWaiter (#253)", () => {
  it("새 태스크가 타깃 그룹에서 healthy 가 되면 이전 태스크 드레이닝을 기다리지 않고 끝내며 진행 상황을 남긴다", async () => {
    const { waiter, input, lines, sleep, createClients, aws } = makeWaiter([
      { deployments: [newDeployment({ pendingCount: 1 }), oldDeployment()], tasks: [newTask({ lastStatus: "PROVISIONING", ip: undefined }), oldTask] },
      { deployments: [newDeployment({ pendingCount: 1 }), oldDeployment()], tasks: [newTask({ lastStatus: "PENDING" }), oldTask] },
      {
        deployments: [newDeployment({ runningCount: 1 }), oldDeployment()],
        tasks: [newTask(), oldTask],
        targets: [{ ip: "10.0.0.10", state: "healthy" }, { ip: "10.0.1.20", state: "initial" }],
      },
      {
        deployments: [newDeployment({ runningCount: 1 }), oldDeployment()],
        tasks: [newTask(), oldTask],
        targets: [{ ip: "10.0.0.10", state: "healthy" }, { ip: "10.0.1.20", state: "healthy" }],
      },
    ]);

    await waiter.wait(input);

    expect(createClients).toHaveBeenCalledWith("ap-northeast-2", input.credentials);
    expect(aws.polls()).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(lines.some((line) => line.includes("새 태스크 시작 중"))).toBe(true);
    expect(lines.some((line) => line.includes("새 태스크 실행 (1/1)"))).toBe(true);
    expect(lines.some((line) => line.includes("타깃 등록"))).toBe(true);
    expect(lines.some((line) => line.includes("헬스체크 통과 (1/1)"))).toBe(true);
    expect(lines.at(-1)).toContain("롤아웃 완료");
    // 이전 태스크 타깃은 빼서 성공 뒤에 이전 버전이 섞여 응답하지 않게 한다
    expect(aws.deregistered).toEqual(["10.0.0.10"]);
    expect(lines.some((line) => line.includes("이전 태스크 1개를 타깃 그룹에서 뺐어요"))).toBe(true);
    // 같은 상태는 다시 쓰지 않는다
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("배포가 이미 COMPLETED 면 바로 끝낸다 (변경 없는 apply · 재시도)", async () => {
    const { waiter, input, sleep, aws } = makeWaiter([
      { deployments: [newDeployment({ runningCount: 1, rolloutState: "COMPLETED" })] },
    ]);

    await waiter.wait(input);

    expect(aws.polls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("새 태스크가 중지되면 ECS stoppedReason 과 컨테이너 종료 사유로 바로 실패한다", async () => {
    const { waiter, input } = makeWaiter([
      { deployments: [newDeployment({ pendingCount: 1 }), oldDeployment()], tasks: [newTask({ lastStatus: "PENDING" }), oldTask] },
      {
        deployments: [newDeployment(), oldDeployment()],
        tasks: [
          newTask({
            lastStatus: "STOPPED",
            desiredStatus: "STOPPED",
            stoppedReason: "Essential container in task exited",
            containers: [{ name: "demo", exitCode: 1, reason: "Error: Cannot find module 'express'" }],
          }),
          oldTask,
        ],
        events: [
          { message: "(service cam-x) has reached a steady state.", createdAt: new Date("2026-10-01T00:05:00Z") },
          { message: "(service cam-x) has started 1 tasks: (task new1).", createdAt: new Date("2026-10-02T00:00:04Z") },
        ],
      },
    ]);

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_TASK_STOPPED");
    expect(error.detail).toContain("ECS 이벤트: (service cam-x) has started 1 tasks");
    expect(error.detail).not.toContain("steady state");
    expect(error.detail).toContain("새 태스크가 중지되었습니다");
    expect(error.detail).toContain("Essential container in task exited");
    expect(error.detail).toContain("종료 코드 1");
    expect(error.detail).toContain("Cannot find module 'express'");
  });

  it("헬스체크 실패로 중지된 태스크는 타깃 그룹의 실패 사유도 함께 남긴다", async () => {
    const { waiter, input, lines } = makeWaiter([
      {
        deployments: [newDeployment({ runningCount: 1 }), oldDeployment()],
        tasks: [newTask(), oldTask],
        targets: [{ ip: "10.0.1.20", state: "unhealthy", description: "Health checks failed with these codes: [404]" }],
      },
      {
        deployments: [newDeployment(), oldDeployment()],
        tasks: [newTask({ lastStatus: "DEACTIVATING", desiredStatus: "STOPPED", stoppedReason: "Task failed ELB health checks in (target-group cam-x-tg)" }), oldTask],
        targets: [{ ip: "10.0.1.20", state: "draining" }],
      },
    ]);

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_TASK_STOPPED");
    expect(error.detail).toContain("Task failed ELB health checks");
    expect(error.detail).toContain("Health checks failed with these codes: [404]");
    expect(lines.some((line) => line.includes("헬스체크 실패"))).toBe(true);
  });

  it("이전 배포의 태스크가 중지되는 것은 실패로 보지 않는다", async () => {
    const { waiter, input } = makeWaiter([
      {
        deployments: [newDeployment({ runningCount: 1 }), oldDeployment()],
        tasks: [newTask(), { ...oldTask, desiredStatus: "STOPPED", lastStatus: "DEACTIVATING", stoppedReason: "Scaling activity initiated by (deployment ecs-svc/new)" }],
        targets: [{ ip: "10.0.1.20", state: "healthy" }, { ip: "10.0.0.10", state: "draining" }],
      },
    ]);

    await expect(waiter.wait(input)).resolves.toBeUndefined();
  });

  it("회로 차단기가 배포를 FAILED 로 바꾸면 사유와 최근 ECS 이벤트로 실패한다", async () => {
    const { waiter, input } = makeWaiter([
      { deployments: [newDeployment({ pendingCount: 1 }), oldDeployment()] },
      {
        deployments: [
          oldDeployment({ id: "ecs-svc/rollback", status: "PRIMARY", rolloutState: "IN_PROGRESS" }),
          newDeployment({
            status: "ACTIVE",
            rolloutState: "FAILED",
            rolloutStateReason: "ECS deployment circuit breaker: tasks failed to start.",
          }),
        ],
        events: [
          { message: "(service cam-x) rolling back to deployment ecs-svc/rollback.", createdAt: new Date("2026-10-02T00:03:00Z") },
          { message: "(service cam-x) has started 1 tasks: (task new1).", createdAt: new Date("2026-10-02T00:00:04Z") },
        ],
      },
    ]);

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_ROLLOUT_FAILED");
    expect(error.detail).toContain("ECS deployment circuit breaker: tasks failed to start.");
    expect(error.detail).toContain("rolling back to deployment ecs-svc/rollback");
  });

  it("동일 이미지의 이전 task definition으로 롤백된 재시도를 성공으로 오판하지 않는다", async () => {
    const { waiter, input } = makeWaiter([
      { deployments: [oldDeployment({ status: "PRIMARY" })] },
    ]);

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_ROLLOUT_FAILED");
    expect(error.detail).toContain("task definition");
  });

  it("제한 시간 안에 끝나지 않으면 마지막 상태와 함께 실패한다", async () => {
    const { waiter, input, sleep } = makeWaiter(
      [
        {
          deployments: [newDeployment({ runningCount: 1 }), oldDeployment()],
          tasks: [newTask(), oldTask],
          targets: [{ ip: "10.0.1.20", state: "initial" }],
        },
      ],
      { timeoutMs: 10_000 },
    );

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_ROLLOUT_TIMEOUT");
    expect(error.detail).toContain("타깃 등록");
    expect(sleep.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("ECS 서비스가 없으면 실패한다", async () => {
    const { waiter, input, aws } = makeWaiter([]);
    aws.ecsSend.mockImplementationOnce(async () => ({ services: [], failures: [{ reason: "MISSING" }] }));

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_SERVICE_NOT_FOUND");
  });

  it("AWS 조회 오류는 이유를 담아 실패로 바꾼다", async () => {
    const { waiter, input, aws } = makeWaiter([]);
    aws.ecsSend.mockImplementationOnce(async () => {
      throw Object.assign(new Error("User is not authorized to perform: ecs:DescribeServices"), { name: "AccessDeniedException" });
    });

    const error = await captureError(waiter.wait(input));

    expect(error.code).toBe("ECS_ROLLOUT_CHECK_FAILED");
    expect(error.detail).toContain("AccessDeniedException");
  });
});
