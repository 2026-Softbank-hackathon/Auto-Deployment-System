/**
 * apps/api/src/plugins/sse-broker.ts
 * 배포별 EventEmitter 관리. API 메모리 내 SSE 브로드캐스트 (D-31).
 * P1: Redis Streams로 교체 예정.
 *
 * 이벤트 형식:
 *   id: <eventId>
 *   event: <eventType>
 *   data: <JSON string>
 *
 * 버퍼: 배포 ID별 최근 100개 이벤트 보관 (Last-Event-Id 재연결 지원).
 */

import { EventEmitter } from "node:events";
import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface SseEvent {
  id: string;
  event: string;
  data: unknown;
  ts: string;
}

interface DeploymentChannel {
  emitter: EventEmitter;
  buffer: SseEvent[];
}

const MAX_BUFFER = 100;

export class SseBroker {
  private readonly channels = new Map<string, DeploymentChannel>();

  private getOrCreate(deploymentId: string): DeploymentChannel {
    let ch = this.channels.get(deploymentId);
    if (!ch) {
      ch = { emitter: new EventEmitter(), buffer: [] };
      ch.emitter.setMaxListeners(200);
      this.channels.set(deploymentId, ch);
    }
    return ch;
  }

  publish(deploymentId: string, event: Omit<SseEvent, "id" | "ts"> & { id?: string; ts?: string }): void {
    const ch = this.getOrCreate(deploymentId);
    const sseEvent: SseEvent = {
      id: event.id ?? `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      event: event.event,
      data: event.data,
      ts: event.ts ?? new Date().toISOString(),
    };
    ch.buffer.push(sseEvent);
    if (ch.buffer.length > MAX_BUFFER) {
      ch.buffer.shift();
    }
    ch.emitter.emit("event", sseEvent);
  }

  subscribe(deploymentId: string, listener: (event: SseEvent) => void): () => void {
    const ch = this.getOrCreate(deploymentId);
    ch.emitter.on("event", listener);
    return () => {
      ch.emitter.off("event", listener);
    };
  }

  /**
   * lastEventId 이후 버퍼에 있는 이벤트를 반환한다.
   * lastEventId가 null이면 빈 배열 반환.
   */
  replay(deploymentId: string, lastEventId: string | null): SseEvent[] {
    if (!lastEventId) return [];
    const ch = this.channels.get(deploymentId);
    if (!ch) return [];
    const idx = ch.buffer.findIndex((e) => e.id === lastEventId);
    if (idx === -1) return [];
    return ch.buffer.slice(idx + 1);
  }

  cleanup(deploymentId: string): void {
    const ch = this.channels.get(deploymentId);
    if (ch) {
      ch.emitter.removeAllListeners();
      this.channels.delete(deploymentId);
    }
  }
}

declare module "fastify" {
  interface FastifyInstance {
    sseBroker: SseBroker;
  }
}

const sseBrokerPlugin: FastifyPluginAsync = async (fastify) => {
  const broker = new SseBroker();
  fastify.decorate("sseBroker", broker);
};

export default fp(sseBrokerPlugin, { name: "sse-broker" });

/**
 * formatSseMessage converts a SseEvent to the SSE wire format string.
 */
export function formatSseMessage(event: SseEvent): string {
  return [
    `id: ${event.id}`,
    `event: ${event.event}`,
    `data: ${JSON.stringify(event.data)}`,
    "",
    "",
  ].join("\n");
}
