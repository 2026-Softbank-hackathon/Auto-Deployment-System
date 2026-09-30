/**
 * packages/analyzer/src/detectors/docker.ts
 *
 * Dockerfile 감지기.
 *
 * 감지 규칙:
 *   - Dockerfile 유무 확인
 *   - EXPOSE <n> 지시자 파싱 → port 후보
 *   - CMD 지시자 파싱 → command 후보
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import fg from "fast-glob";

export type DockerDetectResult = {
  detected: boolean;
  dockerfilePath?: string;  // serviceDir 기준 상대 경로
  exposedPorts: number[];
  command?: string[];
  detectedFrom: string[];
};

export async function detectDocker(serviceDir: string): Promise<DockerDetectResult> {
  // Search for Dockerfile variants
  const dockerfiles = await fg(
    ["Dockerfile", "Dockerfile.*", "*.Dockerfile"],
    {
      cwd: serviceDir,
      absolute: true,
      onlyFiles: true,
      deep: 1,
    }
  );

  if (dockerfiles.length === 0) {
    return { detected: false, exposedPorts: [], detectedFrom: [] };
  }

  // Prefer bare "Dockerfile"
  const preferred =
    dockerfiles.find((f) => f.endsWith("/Dockerfile")) ?? dockerfiles[0]!;

  const relPath = relative(serviceDir, preferred);
  const detectedFrom: string[] = [relPath];

  let content: string;
  try {
    content = await readFile(preferred, "utf8");
  } catch {
    return { detected: true, dockerfilePath: relPath, exposedPorts: [], detectedFrom };
  }

  // Parse EXPOSE instructions
  const exposedPorts: number[] = [];
  const exposeRe = /^EXPOSE\s+([\d\s/]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = exposeRe.exec(content)) !== null) {
    const parts = match[1]!.trim().split(/\s+/);
    for (const part of parts) {
      const portNum = parseInt(part.split("/")[0]!, 10);
      if (!isNaN(portNum)) {
        exposedPorts.push(portNum);
      }
    }
  }

  if (exposedPorts.length > 0) {
    detectedFrom.push(`${relPath} EXPOSE ${exposedPorts.join(",")}`);
  }

  // Parse CMD instruction (last one wins)
  let command: string[] | undefined;
  const cmdRe = /^CMD\s+(.+)$/gm;
  let cmdMatch: RegExpExecArray | null;
  let lastCmd: string | undefined;
  while ((cmdMatch = cmdRe.exec(content)) !== null) {
    lastCmd = cmdMatch[1]!.trim();
  }

  if (lastCmd) {
    // JSON array form: ["node", "server.js"]
    if (lastCmd.startsWith("[")) {
      try {
        command = JSON.parse(lastCmd) as string[];
        detectedFrom.push(`${relPath} CMD (json)`);
      } catch {
        // fall through to shell form
      }
    }
    // Shell form: node server.js
    if (!command) {
      command = lastCmd.split(/\s+/);
      detectedFrom.push(`${relPath} CMD (shell)`);
    }
  }

  return {
    detected: true,
    dockerfilePath: relPath,
    exposedPorts,
    command,
    detectedFrom,
  };
}
