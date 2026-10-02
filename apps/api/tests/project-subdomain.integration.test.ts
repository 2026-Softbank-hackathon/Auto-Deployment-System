/**
 * apps/api/tests/project-subdomain.integration.test.ts
 * 앱 주소(#300) 생성 · 확인을 실제 PostgreSQL 로 확인한다.
 * PROJECT_TEST_DATABASE_URL 이 없으면 건너뜀. 예: postgres://postgres:postgres@localhost:5436/postgres
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@camellia/db";
import { ProjectService } from "../src/services/project-service.js";

const databaseUrl = process.env["PROJECT_TEST_DATABASE_URL"];
const schema = `project_subdomain_${randomUUID().replaceAll("-", "")}`;
const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
let admin: Pool;
let pool: Pool;
let svc: ProjectService;

describe.skipIf(!databaseUrl)("앱 주소: 실제 PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    svc = new ProjectService(pool, "camellia-deploy.app");
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("고른 주소로 만들고, 고르지 않으면 service-{id}", async () => {
    const chosen = await svc.create({ name: "shop-app", subdomain: "shop" });
    expect(chosen).toMatchObject({ subdomain: "shop", publicUrl: "https://shop.camellia-deploy.app" });

    const plain = await svc.create({ name: "plain-app" });
    expect(plain.subdomain).toBe(`service-${plain.id}`);
    expect((await svc.get(Number(plain.id))).publicUrl).toBe(`https://service-${plain.id}.camellia-deploy.app`);
  });

  it("같은 주소는 409 SUBDOMAIN_TAKEN, 이름이 같으면 기존 CONFLICT", async () => {
    await expect(svc.create({ name: "other", subdomain: "shop" })).rejects.toMatchObject({
      statusCode: 409, code: "SUBDOMAIN_TAKEN",
    });
    await expect(svc.create({ name: "shop-app", subdomain: "shop-2" })).rejects.toMatchObject({
      statusCode: 409, code: "CONFLICT",
    });
  });

  it("주소 확인 — 쓰는 중 · 비어 있음", async () => {
    expect(await svc.subdomainAvailability("SHOP")).toEqual({ name: "shop", available: false, reason: "taken" });
    expect(await svc.subdomainAvailability("shop-3")).toEqual({ name: "shop-3", available: true, reason: null });
  });

  describe("주소 변경 (#301)", () => {
    const sent: unknown[] = [];
    let changeSvc: ProjectService;

    beforeAll(() => {
      changeSvc = new ProjectService(pool, "camellia-deploy.app", {
        send: async (...args: unknown[]) => { sent.push(args); return "job"; },
      } as never);
    });

    async function succeededDeployment(projectId: string, profile = "aws-ecs-basic"): Promise<void> {
      await pool.query(
        `INSERT INTO deployments (project_id, status, target_profile, succeeded_at) VALUES ($1, 'succeeded', $2, NOW())`,
        [projectId, profile],
      );
    }

    it("배포한 적 없는 앱은 바로 바뀐다", async () => {
      const project = await changeSvc.create({ name: "never-deployed" });

      const result = await changeSvc.requestSubdomainChange(Number(project.id), "fresh-name");

      expect(result.accepted).toBe(false);
      expect(result.project).toMatchObject({
        subdomain: "fresh-name",
        addressChange: { status: "succeeded", from: `service-${project.id}`, to: "fresh-name" },
      });
    });

    it("서비스 중이면 changing + 작업, 그동안 새 주소는 다른 앱이 못 쓰고 배포 · 다른 변경은 막힌다", async () => {
      const project = await changeSvc.create({ name: "live-app", subdomain: "live-old" });
      await succeededDeployment(project.id);

      const result = await changeSvc.requestSubdomainChange(Number(project.id), "live-new");

      expect(result.accepted).toBe(true);
      expect(result.project).toMatchObject({ subdomain: "live-old", addressChange: { status: "changing", to: "live-new" } });
      expect(sent.at(-1)).toEqual(["address-change", { project_id: Number(project.id) }, expect.any(Object)]);
      expect(await changeSvc.subdomainAvailability("live-new")).toMatchObject({ available: false, reason: "taken" });
      await expect(changeSvc.create({ name: "thief", subdomain: "live-new" })).rejects.toMatchObject({ code: "SUBDOMAIN_TAKEN" });
      await expect(changeSvc.requestSubdomainChange(Number(project.id), "live-other")).rejects.toMatchObject({
        code: "ADDRESS_CHANGE_IN_PROGRESS",
      });
      const active = await pool.query(
        `SELECT (address_change_status = 'changing' AND address_change_requested_at > NOW() - INTERVAL '30 minutes') AS a
         FROM projects WHERE id = $1 FOR SHARE`,
        [project.id],
      );
      expect(active.rows[0].a).toBe(true);

      // 워커가 사라져 30분 넘게 changing 이면 다시 요청할 수 있다
      await pool.query(
        `UPDATE projects SET address_change_requested_at = NOW() - INTERVAL '31 minutes' WHERE id = $1`,
        [project.id],
      );
      await expect(changeSvc.requestSubdomainChange(Number(project.id), "live-other")).resolves.toMatchObject({
        accepted: true,
      });
    });

    it("정적 사이트로 서비스 중이면 409", async () => {
      const project = await changeSvc.create({ name: "static-app" });
      await succeededDeployment(project.id, "aws-static-basic");

      await expect(changeSvc.requestSubdomainChange(Number(project.id), "static-new")).rejects.toMatchObject({
        statusCode: 409, code: "ADDRESS_CHANGE_STATIC_UNSUPPORTED",
      });
    });
  });
});
