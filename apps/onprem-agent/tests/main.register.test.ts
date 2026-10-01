import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentIdentityHttpClient,
} from "../src/agent-identity.js";
import { FileAgentCredentialStore } from "../src/credential-store.js";
import type { AgentCredential } from "../src/credential-store.js";
import { StructuredLogger } from "../src/logger.js";

// resolveCredential 로직을 main.ts 에서 분리해 단위 테스트하기 위해
// 동일한 조건 분기를 인라인으로 재현한다.

async function resolveCredential(opts: {
  registrationToken: string | undefined;
  storedCredential: AgentCredential | null;
  credentialStore: { save: (c: AgentCredential) => Promise<void> };
  identityClient: { register: (token: string) => Promise<AgentCredential> };
  ensureAgentCredential: (input: {
    store: typeof opts.credentialStore;
    client: typeof opts.identityClient;
    registrationToken?: string;
  }) => Promise<AgentCredential>;
  isRegisterOnly: boolean;
  logger: { warn: (event: string, fields: Record<string, unknown>) => void; info: (event: string, fields: Record<string, unknown>) => void };
}): Promise<AgentCredential> {
  const {
    registrationToken,
    storedCredential,
    credentialStore,
    identityClient,
    ensureAgentCredential,
    isRegisterOnly,
    logger,
  } = opts;

  if (!registrationToken) {
    return storedCredential ?? (await ensureAgentCredential({
      store: credentialStore,
      client: identityClient,
    }));
  }
  if (!storedCredential) {
    return await ensureAgentCredential({
      store: credentialStore,
      client: identityClient,
      registrationToken,
    });
  }
  if (!isRegisterOnly) {
    logger.warn("agent.registration.token_ignored", {
      reason: "stored credential exists; use register subcommand to replace",
    });
    return storedCredential;
  }
  // register-only + stored + token → 강제 재등록
  const next = await identityClient.register(registrationToken);
  if (next.environmentId !== storedCredential.environmentId
      || next.agentId !== storedCredential.agentId) {
    await credentialStore.save(next);
    logger.info("agent.credential.replaced", {
      previousAgentId: storedCredential.agentId,
      previousEnvironmentId: storedCredential.environmentId,
      agentId: next.agentId,
      environmentId: next.environmentId,
    });
    return next;
  }
  logger.info("agent.credential.reconfirmed", {
    agentId: next.agentId,
    environmentId: next.environmentId,
  });
  return storedCredential;
}

// ── helpers ────────────────────────────────────────────────────────────────

const BASE_STORED: AgentCredential = {
  controlPlaneUrl: "https://cp.example.com",
  agentId: "1",
  environmentId: "10",
  agentKey: "stored-key",
};

const BASE_NEW: AgentCredential = {
  controlPlaneUrl: "https://cp.example.com",
  agentId: "2",
  environmentId: "20",
  agentKey: "new-key",
};

function makeLogger() {
  const lines: string[] = [];
  const logger = new StructuredLogger((line) => lines.push(line));
  return { logger, lines };
}

function makeFakeEnsure(credential: AgentCredential) {
  return vi.fn(async () => credential);
}

function makeFakeIdentityClient(credential: AgentCredential) {
  return { register: vi.fn(async () => credential) };
}

function makeFakeStore() {
  return { save: vi.fn(async () => undefined) };
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe("main resolveCredential — 등록 토큰 처리 분기", () => {
  it("토큰 없음 + stored 있음 → stored 반환, ensureAgentCredential 미호출", async () => {
    const fakeEnsure = makeFakeEnsure(BASE_NEW);
    const { logger } = makeLogger();

    const result = await resolveCredential({
      registrationToken: undefined,
      storedCredential: BASE_STORED,
      credentialStore: makeFakeStore(),
      identityClient: makeFakeIdentityClient(BASE_NEW),
      ensureAgentCredential: fakeEnsure,
      isRegisterOnly: false,
      logger,
    });

    expect(result).toBe(BASE_STORED);
    expect(fakeEnsure).not.toHaveBeenCalled();
  });

  it("토큰 있음 + stored 없음 → ensureAgentCredential 으로 신규 등록", async () => {
    const fakeEnsure = makeFakeEnsure(BASE_NEW);
    const { logger } = makeLogger();

    const result = await resolveCredential({
      registrationToken: "reg-token-abc",
      storedCredential: null,
      credentialStore: makeFakeStore(),
      identityClient: makeFakeIdentityClient(BASE_NEW),
      ensureAgentCredential: fakeEnsure,
      isRegisterOnly: false,
      logger,
    });

    expect(result).toBe(BASE_NEW);
    expect(fakeEnsure).toHaveBeenCalledWith(
      expect.objectContaining({ registrationToken: "reg-token-abc" }),
    );
  });

  it("토큰 있음 + stored 있음 + register-only + 다른 env → 새 credential 저장, replaced 로그", async () => {
    const differentEnvNew: AgentCredential = {
      ...BASE_NEW,
      agentId: "99",
      environmentId: "99",
    };
    const fakeStore = makeFakeStore();
    const fakeIdentity = makeFakeIdentityClient(differentEnvNew);
    const { logger, lines } = makeLogger();

    const result = await resolveCredential({
      registrationToken: "reg-token-abc",
      storedCredential: BASE_STORED,
      credentialStore: fakeStore,
      identityClient: fakeIdentity,
      ensureAgentCredential: makeFakeEnsure(BASE_NEW),
      isRegisterOnly: true,
      logger,
    });

    expect(result).toBe(differentEnvNew);
    expect(fakeStore.save).toHaveBeenCalledWith(differentEnvNew);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("agent.credential.replaced");
    expect(events).not.toContain("agent.credential.reconfirmed");
  });

  it("토큰 있음 + stored 있음 + register-only + 같은 env → stored 반환, reconfirmed 로그, save 미호출", async () => {
    const sameEnvNew: AgentCredential = {
      controlPlaneUrl: "https://cp.example.com",
      agentId: BASE_STORED.agentId,
      environmentId: BASE_STORED.environmentId,
      agentKey: "refreshed-key",
    };
    const fakeStore = makeFakeStore();
    const fakeIdentity = makeFakeIdentityClient(sameEnvNew);
    const { logger, lines } = makeLogger();

    const result = await resolveCredential({
      registrationToken: "reg-token-abc",
      storedCredential: BASE_STORED,
      credentialStore: fakeStore,
      identityClient: fakeIdentity,
      ensureAgentCredential: makeFakeEnsure(BASE_NEW),
      isRegisterOnly: true,
      logger,
    });

    expect(result).toBe(BASE_STORED);
    expect(fakeStore.save).not.toHaveBeenCalled();
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("agent.credential.reconfirmed");
    expect(events).not.toContain("agent.credential.replaced");
  });

  it("토큰 있음 + stored 있음 + 일반 모드 → stored 반환, token_ignored 경고, register 미호출", async () => {
    const fakeStore = makeFakeStore();
    const fakeIdentity = makeFakeIdentityClient(BASE_NEW);
    const { logger, lines } = makeLogger();

    const result = await resolveCredential({
      registrationToken: "reg-token-abc",
      storedCredential: BASE_STORED,
      credentialStore: fakeStore,
      identityClient: fakeIdentity,
      ensureAgentCredential: makeFakeEnsure(BASE_NEW),
      isRegisterOnly: false,
      logger,
    });

    expect(result).toBe(BASE_STORED);
    expect(fakeIdentity.register).not.toHaveBeenCalled();
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("agent.registration.token_ignored");
    const warnLine = lines.find((l) =>
      (JSON.parse(l) as { event: string }).event === "agent.registration.token_ignored"
    );
    expect(JSON.parse(warnLine!).level).toBe("warn");
  });
});
