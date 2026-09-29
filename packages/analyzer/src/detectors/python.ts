/**
 * packages/analyzer/src/detectors/python.ts
 *
 * Python 서비스 감지기.
 *
 * 감지 규칙:
 *   - requirements.txt / pyproject.toml / Pipfile 존재 → language=python
 *   - fastapi/flask/django/uvicorn → framework
 *   - uvicorn main:app --port <n> 패턴 → port
 *   - 못 찾으면 기본 8000 후보 + unresolved
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type { UnresolvedField, Warning } from "../types.js";

export type PythonDetectResult = {
  detected: boolean;
  framework?: string;
  port?: number;
  command?: string[];
  envNames: string[];
  detectedFrom: string[];
  unresolved: UnresolvedField[];
  warnings: Warning[];
};

const FRAMEWORK_PACKAGES: Record<string, string> = {
  fastapi: "fastapi",
  flask: "flask",
  django: "django",
  starlette: "starlette",
  tornado: "tornado",
};

export async function detectPython(serviceDir: string): Promise<PythonDetectResult> {
  const detectedFrom: string[] = [];
  const unresolved: UnresolvedField[] = [];
  const warnings: Warning[] = [];

  // ------------------------------------------------------------------
  // Check presence of Python project markers
  // ------------------------------------------------------------------
  const markers: Array<{ file: string; reader: (c: string) => string[] }> = [
    { file: "requirements.txt", reader: parseRequirementsTxt },
    { file: "pyproject.toml", reader: parsePyprojectToml },
    { file: "Pipfile", reader: parsePipfile },
  ];

  let packages: string[] = [];
  let markerFile: string | undefined;

  for (const marker of markers) {
    const path = join(serviceDir, marker.file);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    markerFile = marker.file;
    packages = marker.reader(content);
    detectedFrom.push(marker.file);
    break;
  }

  if (!markerFile) {
    return { detected: false, envNames: [], detectedFrom: [], unresolved: [], warnings: [] };
  }

  // ------------------------------------------------------------------
  // Framework detection
  // ------------------------------------------------------------------
  const packagesLower = packages.map((p) => p.toLowerCase());
  let framework: string | undefined;
  for (const [pkg, stdName] of Object.entries(FRAMEWORK_PACKAGES)) {
    if (packagesLower.some((p) => p.startsWith(pkg))) {
      framework = stdName;
      detectedFrom.push(`${markerFile} (${pkg})`);
      break;
    }
  }

  // ------------------------------------------------------------------
  // Port detection: uvicorn / Procfile / main.py
  // ------------------------------------------------------------------
  let port: number | undefined;
  let command: string[] | undefined;

  // Check Procfile
  const procfilePath = join(serviceDir, "Procfile");
  try {
    const procContent = await readFile(procfilePath, "utf8");
    const portMatch = /--port[= ](\d+)/.exec(procContent);
    if (portMatch) {
      port = parseInt(portMatch[1], 10);
      detectedFrom.push(`Procfile (port ${port})`);
    }
    const webLine = /^web:\s*(.+)/m.exec(procContent);
    if (webLine) {
      command = webLine[1].trim().split(/\s+/);
      detectedFrom.push("Procfile web:");
    }
  } catch {
    // no Procfile
  }

  // Scan Python source files for uvicorn run pattern
  if (port === undefined) {
    const pyFiles = await fg(["**/*.py"], {
      cwd: serviceDir,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/__pycache__/**", "**/venv/**", "**/.venv/**"],
      deep: 3,
    });

    for (const file of pyFiles) {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }

      // uvicorn.run(..., port=8000)
      const uvicornPortMatch = /uvicorn\.run\s*\([^)]*port\s*=\s*(\d+)/s.exec(content);
      if (uvicornPortMatch) {
        port = parseInt(uvicornPortMatch[1], 10);
        const rel = file.replace(serviceDir + "/", "");
        detectedFrom.push(`${rel} (uvicorn.run port=${port})`);
        break;
      }

      // app.run(port=5000) Flask pattern
      const flaskPortMatch = /\.run\s*\([^)]*port\s*=\s*(\d+)/s.exec(content);
      if (flaskPortMatch) {
        port = parseInt(flaskPortMatch[1], 10);
        const rel = file.replace(serviceDir + "/", "");
        detectedFrom.push(`${rel} (.run port=${port})`);
        break;
      }
    }
  }

  // Default port candidate for Python services
  if (port === undefined) {
    port = 8000;
    unresolved.push({
      path: "services.<name>.port",
      reason: "No explicit port found; defaulting to 8000 (uvicorn default). Confirm actual port.",
    });
  }

  // Default uvicorn command for FastAPI
  if (command === undefined && (framework === "fastapi" || framework === "starlette")) {
    command = ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", String(port)];
  }

  // ------------------------------------------------------------------
  // Env names
  // ------------------------------------------------------------------
  const envNames = await scanPythonEnvNames(serviceDir);

  return {
    detected: true,
    framework,
    port,
    command,
    envNames,
    detectedFrom,
    unresolved,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dependency file parsers
// ---------------------------------------------------------------------------

function parseRequirementsTxt(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim().split(/[>=<!;\[]/)[0].trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"));
}

function parsePyprojectToml(content: string): string[] {
  // Extract from [project] dependencies or [tool.poetry.dependencies]
  const packages: string[] = [];
  const depsBlock = /dependencies\s*=\s*\[([^\]]*)\]/s.exec(content);
  if (depsBlock) {
    const raw = depsBlock[1];
    const re = /"([a-zA-Z0-9_-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(raw)) !== null) {
      packages.push(match[1]);
    }
  }

  // tool.poetry.dependencies table
  const poetryDeps = /\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/.exec(content);
  if (poetryDeps) {
    const block = poetryDeps[1];
    const re = /^([a-zA-Z0-9_-]+)\s*=/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(block)) !== null) {
      if (match[1].toLowerCase() !== "python") {
        packages.push(match[1]);
      }
    }
  }

  return packages;
}

function parsePipfile(content: string): string[] {
  const packages: string[] = [];
  const inPackages = /\[packages\]([\s\S]*?)(?=\[|$)/.exec(content);
  if (inPackages) {
    const re = /^([a-zA-Z0-9_-]+)\s*=/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(inPackages[1])) !== null) {
      packages.push(match[1]);
    }
  }
  return packages;
}

/**
 * Python 소스에서 os.environ["X"] 및 os.getenv("X") 패턴으로 환경변수 이름 추출.
 */
async function scanPythonEnvNames(serviceDir: string): Promise<string[]> {
  const pyFiles = await fg(["**/*.py"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/__pycache__/**", "**/venv/**", "**/.venv/**"],
    deep: 4,
  });

  const names = new Set<string>();
  const patterns = [
    /os\.environ\s*\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /os\.getenv\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
    /os\.environ\.get\s*\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  ];

  for (const file of pyFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const re of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        names.add(match[1]);
      }
    }
  }

  return [...names].sort();
}
