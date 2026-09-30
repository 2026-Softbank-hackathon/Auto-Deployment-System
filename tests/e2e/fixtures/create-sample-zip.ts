/**
 * tests/e2e/fixtures/create-sample-zip.ts
 *
 * sample-express.zip 픽스처를 Node.js 내장 모듈만으로 생성한다.
 * ZIP local file header + central directory 포맷을 직접 작성한다 (DEFLATE 없이 store 모드).
 *
 * Express Hello World: package.json + server.js + Dockerfile
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

const FIXTURE_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "."
);
export const ZIP_PATH = path.join(FIXTURE_DIR, "sample-express.zip");

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
  // standard CRC-32 table
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

// ── file contents ─────────────────────────────────────────────────────────────

const PACKAGE_JSON = Buffer.from(
  JSON.stringify(
    {
      name: "sample-express",
      version: "1.0.0",
      description: "Express Hello World",
      main: "server.js",
      scripts: { start: "node server.js" },
      dependencies: { express: "^4.18.0" },
    },
    null,
    2
  )
);

const SERVER_JS = Buffer.from(
  `const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/', (_req, res) => res.send('Hello World'));

app.listen(PORT, () => {
  // server started
});
`
);

const DOCKERFILE = Buffer.from(
  `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`
);

// ── public API ────────────────────────────────────────────────────────────────

export async function createSampleZip(): Promise<string> {
  if (existsSync(ZIP_PATH)) return ZIP_PATH;

  await mkdir(FIXTURE_DIR, { recursive: true });

  const zip = buildZip([
    { name: "package.json", data: PACKAGE_JSON },
    { name: "server.js", data: SERVER_JS },
    { name: "Dockerfile", data: DOCKERFILE },
  ]);

  await writeFile(ZIP_PATH, zip);
  return ZIP_PATH;
}

export function createSampleZipBuffer(): Buffer {
  return buildZip([
    { name: "package.json", data: PACKAGE_JSON },
    { name: "server.js", data: SERVER_JS },
    { name: "Dockerfile", data: DOCKERFILE },
  ]);
}
