/**
 * packages/contracts/src/events.ts — GET /deployments/:id/events (SSE, text/event-stream)
 *
 * 와이어 형식 (메시지마다):
 *   id: evt_<16자>
 *   event: <DeploymentEventName>
 *   data: <JSON — DeploymentEventData<event>>
 *
 * - 30초마다 `: heartbeat` 주석 줄이 온다. SSE 주석이라 EventSource 는 이벤트로 전달하지 않는다.
 * - 재연결 시 브라우저가 보내는 Last-Event-ID 이후 이벤트를 다시 보내 준다 (배포별 최근 100개, API 메모리).
 * - 발행 위치: 워커(pg NOTIFY → API 가 중계) · API 라우트(승인 · IR 편집 · 누락 리소스 결정).
 *   워커 이벤트 페이로드에는 deploymentId 가 없고, API 이벤트에는 있다.
 */

import { z } from "zod";
import { ApprovalGateSchema, DeploymentStatusSchema, IdStringSchema, PgBigIntSchema } from "./common.js";

/**
 * 상태 전이. 발행 위치에 따라 두 형태:
 *   워커(분석 핸들러) `{ status }` · API(승인 라우트) `{ deploymentId, from, to, reason? }`
 */
export const StateChangedDataSchema = z.union([
  z.object({ status: DeploymentStatusSchema }).strict(),
  z
    .object({
      deploymentId: IdStringSchema,
      from: DeploymentStatusSchema,
      to: DeploymentStatusSchema,
      /** 거절일 때만 (note 또는 "사용자 거절") */
      reason: z.string().optional(),
    })
    .strict(),
]);

/** 분석 진행 (워커). step 으로 구분 */
export const AnalysisProgressDataSchema = z.discriminatedUnion("step", [
  z.object({ step: z.literal("detecting") }).strict(),
  z.object({ step: z.literal("cache_hit"), cached_source_version_id: PgBigIntSchema }).strict(),
  z.object({ step: z.literal("complete"), ir_valid: z.boolean(), from_cache: z.literal(true).optional() }).strict(),
]);

/** 사용자 승인 대기 시작 (워커 — 지금은 gate=target 만) */
export const ApprovalRequestedDataSchema = z.object({ gate: ApprovalGateSchema }).strict();

/** 단계 로그 한 줄 (워커). line = "[ISO 시각] 내용" */
export const LogLineDataSchema = z.object({ step: z.string(), line: z.string() }).strict();

/** IR 수동 편집 완료 (API) */
export const IrUpdatedDataSchema = z
  .object({ deploymentId: IdStringSchema, version: PgBigIntSchema, source: z.string() })
  .strict();

/** 누락 리소스 결정 반영 (API) */
export const MissingResourcesUpdatedDataSchema = z
  .object({ deploymentId: IdStringSchema, resolved: z.number().int(), remaining: z.number().int() })
  .strict();

/** `{ event, data }` — event 이름으로 data 형태가 정해지는 discriminated union */
export const DeploymentEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("state_changed"), data: StateChangedDataSchema }),
  z.object({ event: z.literal("analysis.progress"), data: AnalysisProgressDataSchema }),
  z.object({ event: z.literal("approval_requested"), data: ApprovalRequestedDataSchema }),
  z.object({ event: z.literal("log.line"), data: LogLineDataSchema }),
  z.object({ event: z.literal("ir_updated"), data: IrUpdatedDataSchema }),
  z.object({ event: z.literal("missing_resources_updated"), data: MissingResourcesUpdatedDataSchema }),
]);
export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;
export type DeploymentEventName = DeploymentEvent["event"];
/** 이벤트 이름 → data 타입. 예: `DeploymentEventData<"log.line">` */
export type DeploymentEventData<E extends DeploymentEventName> = Extract<DeploymentEvent, { event: E }>["data"];

export const DEPLOYMENT_EVENT_NAMES: readonly DeploymentEventName[] = DeploymentEventSchema.options.map(
  (o) => o.shape.event.value,
);
