/**
 * apps/worker/src/deps.ts
 *
 * WorkerDeps 타입 정의 — 핸들러에 주입되는 의존성 모음.
 */

import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import type { Notifier } from "./notifier.js";
import type { Logger } from "pino";

export type WorkerDeps = {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  notifier?: Notifier;
  log?: Logger;
};
