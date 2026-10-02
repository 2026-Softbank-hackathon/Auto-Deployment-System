import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { addEntry, countEntries, listEntries, ping, storageName } from "./db.js";
import { renderPage } from "./page.js";

const port = Number(process.env.PORT) || 3000;

const app = new Hono();

// DB 에 질의가 안 되면 503 — 배포 시스템의 헬스체크가 DB 연결까지 확인한다
app.get("/health", (c) => {
  try {
    ping();
    return c.json({ status: "ok", storage: storageName() });
  } catch (error) {
    console.error("health check failed", error);
    return c.json({ status: "error", storage: storageName() }, 503);
  }
});

app.get("/api/entries", (c) =>
  c.json({ storage: storageName(), count: countEntries(), entries: listEntries() }),
);

app.post("/api/entries", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim().slice(0, 40);
  const message = String(body.message ?? "").trim().slice(0, 200);
  if (!name || !message) return c.json({ error: "name 과 message 가 필요합니다." }, 400);
  const entry = addEntry(name, message);
  // 화면의 폼에서 보낸 요청이면 목록으로 돌아간다
  if (c.req.header("accept")?.includes("text/html")) return c.redirect("/", 303);
  return c.json(entry, 201);
});

app.get("/", (c) => c.html(renderPage(storageName(), countEntries(), listEntries())));

const server = serve({ fetch: app.fetch, port }, (address) => {
  console.log(`sample-sqlite-web listening on :${address.port} (storage: ${storageName()})`);
});

// docker stop · ECS 태스크 종료 시 SIGTERM → 새 요청을 막고 처리 중인 요청만 마친 뒤 종료
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
