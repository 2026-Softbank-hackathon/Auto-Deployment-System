import { describe, expect, it } from "vitest";
import {
  createComposeProjectName,
  renderComposeDocument,
} from "../src/compose.js";
import { createJob } from "./fixtures.js";

describe("Docker Compose 렌더링", () => {
  it("digest 이미지, 동적 loopback 포트, 환경변수 이름, health 설정을 반영한다", () => {
    const job = createJob();
    const imageUri = `${job.image.repositoryUri}@${job.image.digest}`;
    const compose = renderComposeDocument(job, imageUri);

    expect(compose).toContain(`image: ${JSON.stringify(imageUri)}`);
    expect(compose).toContain('platform: "linux/amd64"');
    expect(compose).toContain(`${JSON.stringify("127.0.0.1::3000")}`);
    expect(compose).toContain(JSON.stringify("APP_MESSAGE"));
    expect(compose).toContain("/health");
    expect(compose).toContain("cpus: 0.25");
    expect(compose).toContain("512M");
    expect(compose).not.toContain("do-not-log-this");
  });

  it("deployment, environment, digest별로 충돌하지 않는 project name을 만든다", () => {
    const first = createComposeProjectName(createJob());
    const same = createComposeProjectName(createJob());
    const otherEnvironment = createComposeProjectName(
      createJob({ environmentId: "env-onprem-2" }),
    );
    const otherDigest = createComposeProjectName(
      createJob({
        image: { ...createJob().image, digest: `sha256:${"b".repeat(64)}` },
      }),
    );

    expect(first).toBe(same);
    expect(first).not.toBe(otherEnvironment);
    expect(first).not.toBe(otherDigest);
    expect(first).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
  });

  it("정상 환경변수 이름이 아닌 key를 거부한다", () => {
    expect(() =>
      renderComposeDocument(
        createJob({ environment: { "BAD-KEY": "secret" } }),
        `${createJob().image.repositoryUri}@${createJob().image.digest}`,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid_job" }));
  });
});
