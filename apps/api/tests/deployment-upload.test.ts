import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import multipartPlugin from "../src/plugins/multipart.js";
import errorHandlerPlugin from "../src/plugins/error-handler.js";
import swaggerPlugin from "../src/plugins/swagger.js";
import deploymentsRoutes from "../src/routes/deployments.js";
import type { DeploymentService } from "../src/services/deployment-service.js";

let server: FastifyInstance;
const source = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80]);
const create = vi.fn(async () => ({
  deploymentId: "42", status: "received", eventsUrl: "/api/v1/deployments/42/events",
}));

beforeEach(async () => {
  create.mockClear();
  server = Fastify({ logger: false });
  await server.register(errorHandlerPlugin);
  await server.register(multipartPlugin);
  await server.register(swaggerPlugin);
  await server.register(deploymentsRoutes, {
    prefix: "/api/v1/deployments",
    deploymentService: { create } as unknown as DeploymentService,
  });
  await server.ready();
});

afterEach(async () => server.close());

async function upload(
  order: string[],
  target = "aws",
  contents: Buffer = source,
  environmentId = "12",
) {
  const form = new FormData();
  for (const field of order) {
    if (field === "source") form.append(field, new Blob([contents], { type: "application/zip" }), "mock.zip");
    if (field === "project_id") form.append(field, "7");
    if (field === "target") form.append(field, target);
    if (field === "environment_id") form.append(field, environmentId);
  }
  const request = new Request("http://localhost/api/v1/deployments", { method: "POST", body: form });
  const contentType = request.headers.get("content-type")!;
  const boundary = contentType.split("boundary=")[1]!;
  const body = Buffer.from(await request.arrayBuffer());
  const marker = Buffer.from(`--${boundary}`);
  const stream = Readable.from((async function* () {
    let offset = 0;
    while (offset < body.length) {
      const next = body.indexOf(marker, offset + marker.length);
      yield body.subarray(offset, next === -1 ? body.length : next);
      await setImmediate();
      if (next === -1) break;
      offset = next;
    }
  })());
  return server.inject({
    method: "POST", url: "/api/v1/deployments",
    headers: { "content-type": contentType },
    payload: stream,
  });
}

describe("POST deployments browser multipart field ordering", () => {
  it.each([
    ["aws", ["source", "project_id", "target"]],
    ["onprem", ["source", "project_id", "target"]],
    ["aws", ["project_id", "source", "target"]],
    ["onprem", ["project_id", "source", "target"]],
    ["aws", ["project_id", "target", "source"]],
    ["onprem", ["project_id", "target", "source"]],
  ] as const)("%s 필드 순서 %j를 처리한다", async (target, order) => {
    const response = await upload([...order], target);
    expect(response.statusCode, response.body).toBe(202);
    // vendor → profile 매핑은 서비스가 최종 연결 type 으로 한다 (#215)
    expect(create).toHaveBeenCalledWith({
      projectId: 7, targetVendor: target,
      fileBuffer: source,
    });
  });

  it("environment_id 만 보내면 target 없이 서비스로 넘긴다 (#215)", async () => {
    const response = await upload(["source", "project_id", "environment_id"]);
    expect(response.statusCode, response.body).toBe(202);
    expect(create).toHaveBeenCalledWith({ projectId: 7, environmentId: 12, fileBuffer: source });
  });

  it("environment_id 와 target 을 같이 보내면 둘 다 넘긴다 (일치 여부는 서비스가 확인)", async () => {
    const response = await upload(["source", "project_id", "target", "environment_id"], "onprem");
    expect(response.statusCode, response.body).toBe(202);
    expect(create).toHaveBeenCalledWith({
      projectId: 7, targetVendor: "onprem", environmentId: 12, fileBuffer: source,
    });
  });

  it.each(["0", "abc", "1.5"])("environment_id=%s 는 거절한다", async (value) => {
    const response = await upload(["source", "project_id", "environment_id"], "aws", source, value);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("environment_id");
    expect(create).not.toHaveBeenCalled();
  });

  it("environment_id 와 함께 보낸 잘못된 target 은 거절한다", async () => {
    const response = await upload(["source", "project_id", "target", "environment_id"], "aws-ecs-basic");
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("Profile ID를 vendor로 보내면 여전히 거절한다", async () => {
    const response = await upload(["source", "project_id", "target"], "aws-ecs-basic");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("target 은 aws 또는 onprem");
    expect(create).not.toHaveBeenCalled();
  });

  it("target 누락을 거절한다", async () => {
    expect((await upload(["source", "project_id"])).statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("파일 누락을 거절한다", async () => {
    const response = await upload(["project_id", "target"]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("source 파일이 없습니다");
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["target", "project_id"])("중복된 %s 필드를 거절한다", async (field) => {
    const response = await upload(["source", "project_id", "target", field]);
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("중복된 environment_id 필드를 거절한다", async () => {
    const response = await upload(["source", "project_id", "environment_id", "environment_id"]);
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("project_id 누락을 해당 필드 오류로 거절한다", async () => {
    const response = await upload(["source", "target"]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("project_id 필드가 필요");
    expect(create).not.toHaveBeenCalled();
  });

  it("빈 파일을 거절한다", async () => {
    const response = await upload(["source", "project_id", "target"], "aws", Buffer.alloc(0));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("비어");
    expect(create).not.toHaveBeenCalled();
  });
});
