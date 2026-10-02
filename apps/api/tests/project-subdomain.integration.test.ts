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
});
