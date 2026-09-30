/**
 * tests/e2e/fixtures/create-sample-zip.ts
 *
 * E2E 테스트용 fixture zip 파일을 Node.js 내장 모듈만으로 생성한다.
 * ZIP local file header + central directory 포맷을 직접 작성한다 (DEFLATE 없이 store 모드).
 *
 * 4개의 fixture 함수를 export 한다:
 *   1. createSampleExpressZipBuffer  — Express + Dockerfile
 *   2. createSamplePythonFastapiZipBuffer — FastAPI (Dockerfile 없음, Railpack fallback 감지)
 *   3. createSampleNodePostgresZipBuffer  — Express + pg + .env.example + Dockerfile
 *   4. createSampleMsaZipBuffer           — 다중 서비스 (services/api + services/worker)
 *
 * 하위 호환:
 *   createSampleZipBuffer  — createSampleExpressZipBuffer 의 alias (upload-to-ir.test.ts 호환)
 */

// ── ZIP builder (store mode, no compression) ──────────────────────────────────

function u16LE(n: number): Buffer {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32LE(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function crc32(buf: Buffer): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[((crc ^ buf[i]!) & 0xff)!]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _crc32Table: number[] | undefined;
function crc32Table(): number[] {
  if (_crc32Table) return _crc32Table;
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t.push(c >>> 0);
  }
  _crc32Table = t;
  return t;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralDirs: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    // local file header (30 bytes + name + data)
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // signature
      u16LE(20),           // version needed: 2.0
      u16LE(0),            // flags
      u16LE(0),            // compression: stored
      u16LE(0),            // mod time
      u16LE(0),            // mod date
      u32LE(crc),
      u32LE(size),         // compressed
      u32LE(size),         // uncompressed
      u16LE(nameBytes.length),
      u16LE(0),            // extra field length
      nameBytes,
      data,
    ]);

    localHeaders.push(local);

    // central directory entry
    const cd = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // signature
      u16LE(20),           // version made by
      u16LE(20),           // version needed
      u16LE(0),            // flags
      u16LE(0),            // compression: stored
      u16LE(0),            // mod time
      u16LE(0),            // mod date
      u32LE(crc),
      u32LE(size),
      u32LE(size),
      u16LE(nameBytes.length),
      u16LE(0),            // extra field length
      u16LE(0),            // comment length
      u16LE(0),            // disk start
      u16LE(0),            // internal attr
      u32LE(0),            // external attr
      u32LE(offset),       // local header offset
      nameBytes,
    ]);

    centralDirs.push(cd);
    offset += local.length;
  }

  const centralStart = offset;
  const centralData = Buffer.concat(centralDirs);
  const centralSize = centralData.length;

  // end of central directory
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), // signature
    u16LE(0),                               // disk number
    u16LE(0),                               // disk with CD start
    u16LE(entries.length),                  // entries on disk
    u16LE(entries.length),                  // total entries
    u32LE(centralSize),
    u32LE(centralStart),
    u16LE(0),                               // comment length
  ]);

  return Buffer.concat([...localHeaders, centralData, eocd]);
}

// ── 1. Express + Dockerfile ───────────────────────────────────────────────────

const EXPRESS_PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    {
      name: "express-basic",
      version: "1.0.0",
      dependencies: { express: "^4" },
      scripts: { start: "node server.js" },
    },
    null,
    2
  )
);

const EXPRESS_SERVER_JS = Buffer.from(
  `const express = require("express");
const app = express();
app.get("/health", (req, res) => res.send("ok"));
app.listen(3000);
`
);

const EXPRESS_DOCKERFILE = Buffer.from(
  `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`
);

export function createSampleExpressZipBuffer(): Buffer {
  return buildZip([
    { name: "package.json", data: EXPRESS_PACKAGE_JSON },
    { name: "server.js", data: EXPRESS_SERVER_JS },
    { name: "Dockerfile", data: EXPRESS_DOCKERFILE },
  ]);
}

// ── 2. Python FastAPI (Dockerfile 없음) ───────────────────────────────────────

const FASTAPI_REQUIREMENTS_TXT = Buffer.from(`fastapi\nuvicorn\n`);

const FASTAPI_MAIN_PY = Buffer.from(
  `from fastapi import FastAPI
import uvicorn
app = FastAPI()
@app.get("/health")
def health(): return {"ok": True}
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
`
);

export function createSamplePythonFastapiZipBuffer(): Buffer {
  return buildZip([
    { name: "requirements.txt", data: FASTAPI_REQUIREMENTS_TXT },
    { name: "main.py", data: FASTAPI_MAIN_PY },
  ]);
}

// ── 3. Node + PostgreSQL ──────────────────────────────────────────────────────

const NODE_PG_PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    {
      name: "node-postgres",
      version: "0.1.0",
      dependencies: { express: "^4", pg: "^8" },
    },
    null,
    2
  )
);

const NODE_PG_SERVER_JS = Buffer.from(
  `const express = require("express");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.get("/health", (req, res) => res.send("ok"));
app.listen(8080);
`
);

const NODE_PG_ENV_EXAMPLE = Buffer.from(
  `DATABASE_URL=postgres://user:pass@host:5432/db\nNODE_ENV=production\n`
);

const NODE_PG_DOCKERFILE = Buffer.from(
  `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
`
);

export function createSampleNodePostgresZipBuffer(): Buffer {
  return buildZip([
    { name: "package.json", data: NODE_PG_PACKAGE_JSON },
    { name: "server.js", data: NODE_PG_SERVER_JS },
    { name: ".env.example", data: NODE_PG_ENV_EXAMPLE },
    { name: "Dockerfile", data: NODE_PG_DOCKERFILE },
  ]);
}

// ── 4. MSA (services/api + services/worker, 루트 package.json 없음) ───────────

const MSA_API_PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    { name: "msa-api", dependencies: { express: "^4" } },
    null,
    2
  )
);

const MSA_API_SERVER_JS = Buffer.from(
  `const express = require("express");
const app = express();
app.get("/health", (req, res) => res.send("ok"));
app.listen(3000);
`
);

const MSA_API_DOCKERFILE = Buffer.from(
  `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`
);

const MSA_WORKER_PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    { name: "msa-worker", dependencies: {} },
    null,
    2
  )
);

const MSA_WORKER_JS = Buffer.from(
  `setInterval(() => {
  process.stdout.write("worker tick\\n");
}, 1000);
`
);

const MSA_WORKER_DOCKERFILE = Buffer.from(
  `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "worker.js"]
`
);

export function createSampleMsaZipBuffer(): Buffer {
  return buildZip([
    { name: "services/api/package.json", data: MSA_API_PACKAGE_JSON },
    { name: "services/api/server.js", data: MSA_API_SERVER_JS },
    { name: "services/api/Dockerfile", data: MSA_API_DOCKERFILE },
    { name: "services/worker/package.json", data: MSA_WORKER_PACKAGE_JSON },
    { name: "services/worker/worker.js", data: MSA_WORKER_JS },
    { name: "services/worker/Dockerfile", data: MSA_WORKER_DOCKERFILE },
  ]);
}

// ── 하위 호환 alias (upload-to-ir.test.ts) ────────────────────────────────────

export const createSampleZipBuffer = createSampleExpressZipBuffer;
