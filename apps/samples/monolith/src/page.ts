import type { AppInfo } from "./info.js";

// 버전마다 색을 달리해 v1 → v2 전환이 멀리서도 보이게 한다.
const ACCENTS: Record<string, string> = {
  v1: "#3b82f6",
  v2: "#22c55e",
  v3: "#f59e0b",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPage(info: AppInfo): string {
  const accent = ACCENTS[info.version] ?? "#a855f7";
  const message = info.message
    ? escapeHtml(info.message)
    : `<span class="muted">APP_MESSAGE 미설정</span>`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sample-monolith ${escapeHtml(info.version)}</title>
<style>
  :root { --accent: ${accent}; --bg: #0b1020; --panel: #121a2f; --line: #24304f; --text: #e8ecf6; --muted: #8a96b3; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--accent) 22%, var(--bg)), var(--bg) 60%);
    color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  }
  main { width: min(960px, 100%); }
  header { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 1.1rem; letter-spacing: .04em; }
  .live { display: inline-flex; align-items: center; gap: .5em; }
  .dot { width: .7em; height: .7em; border-radius: 50%; background: #22c55e; box-shadow: 0 0 12px #22c55e; }
  .live.down .dot { background: #ef4444; box-shadow: 0 0 12px #ef4444; }
  .version {
    margin: 24px 0; padding: 24px 0; text-align: center; border-radius: 28px;
    font-size: clamp(6rem, 22vw, 15rem); font-weight: 800; line-height: 1; letter-spacing: -.04em;
    color: #fff; background: var(--accent); box-shadow: 0 20px 60px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .env { text-align: center; font-size: clamp(2rem, 6vw, 3.5rem); font-weight: 700; margin-bottom: 24px; }
  .env small { display: block; font-size: 1rem; font-weight: 500; color: var(--muted); letter-spacing: .12em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 14px 24px; margin: 0; padding: 24px 28px; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; font-size: clamp(1rem, 2.4vw, 1.4rem); }
  dt { color: var(--muted); letter-spacing: .08em; }
  dd { margin: 0; font-weight: 600; word-break: break-all; }
  .muted { color: var(--muted); font-weight: 400; }
  footer { margin-top: 16px; text-align: center; color: var(--muted); font-size: .95rem; }
  code { color: var(--text); }
</style>
</head>
<body>
<main>
  <header>
    <span>sample-monolith</span>
    <span class="live" id="live"><span class="dot"></span><span id="live-text">LIVE</span></span>
  </header>
  <div class="version">${escapeHtml(info.version)}</div>
  <div class="env"><small>RUNNING ON</small>${escapeHtml(info.environment)}</div>
  <dl>
    <dt>HOST</dt><dd>${escapeHtml(info.hostname)}</dd>
    <dt>STARTED</dt><dd>${escapeHtml(info.startedAt)}</dd>
    <dt>UPTIME</dt><dd id="uptime">${info.uptimeSeconds}s</dd>
    <dt>MESSAGE</dt><dd>${message}</dd>
  </dl>
  <footer><code>GET /health</code> · <code>GET /api/info</code> · node ${escapeHtml(info.node)}</footer>
</main>
<script>
  // 3초마다 /api/info 확인. 새 버전이 응답하기 시작하면(롤링 업데이트) 새로고침한다.
  const shownVersion = ${JSON.stringify(info.version)};
  const live = document.getElementById("live");
  const liveText = document.getElementById("live-text");
  async function poll() {
    try {
      const res = await fetch("/api/info", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const info = await res.json();
      if (info.version !== shownVersion) return location.reload();
      document.getElementById("uptime").textContent = info.uptimeSeconds + "s";
      live.classList.remove("down");
      liveText.textContent = "LIVE";
    } catch {
      live.classList.add("down");
      liveText.textContent = "OFFLINE";
    }
  }
  setInterval(poll, 3000);
</script>
</body>
</html>`;
}
