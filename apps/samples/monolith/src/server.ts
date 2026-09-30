import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getInfo } from "./info.js";
import { renderPage } from "./page.js";
import { APP_VERSION } from "./version.js";

const port = Number(process.env.PORT) || 3000;

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", version: APP_VERSION }));
app.get("/api/info", (c) => c.json(getInfo()));
app.get("/", (c) => c.html(renderPage(getInfo())));

const server = serve({ fetch: app.fetch, port }, (address) => {
  console.log(`sample-monolith ${APP_VERSION} listening on :${address.port}`);
});

// docker stop · ECS 태스크 종료 시 SIGTERM → 새 요청을 막고 처리 중인 요청만 마친 뒤 종료
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
