import type { Entry } from "./db.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPage(storage: string, count: number, entries: Entry[]): string {
  const items = entries
    .map(
      (entry) => `<li><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml(entry.message)}</span>
        <time>${escapeHtml(entry.created_at)}</time></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>방명록 · ${escapeHtml(storage)}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
  .badge { display: inline-block; padding: 6px 14px; border-radius: 999px; background: #0ea5e9; color: #fff; font-weight: 700; }
  form { display: grid; gap: 8px; margin: 24px 0; }
  input, textarea, button { font: inherit; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #1e293b; color: inherit; }
  button { background: #0ea5e9; border: 0; font-weight: 700; cursor: pointer; }
  ul { list-style: none; padding: 0; display: grid; gap: 8px; }
  li { display: grid; gap: 4px; padding: 12px; border-radius: 8px; background: #1e293b; }
  time { font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<main>
  <h1>방명록</h1>
  <p>저장소 <span class="badge">${escapeHtml(storage)}</span> · 글 ${count}개</p>
  <form method="post" action="/api/entries">
    <input name="name" placeholder="이름" maxlength="40" required>
    <textarea name="message" placeholder="남길 말" maxlength="200" required></textarea>
    <button type="submit">남기기</button>
  </form>
  <ul>${items}</ul>
</main>
</body>
</html>`;
}
