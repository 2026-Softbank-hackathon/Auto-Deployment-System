/** 운영 화면 숫자 표시 (#308) */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** 바이트 → "12.3 GB" (1GB 미만은 "512 MB") */
export function formatBytes(bytes: number): string {
  if (Math.abs(bytes) >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

/** 부호를 붙인 바이트 차이 → "+0.4 GB" · "−1.2 GB" */
export function formatBytesDelta(bytes: number): string {
  const text = formatBytes(Math.abs(bytes));
  if (bytes === 0) return `±${text}`;
  return `${bytes > 0 ? '+' : '−'}${text}`;
}

export function formatNumber(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

/** 추정 비용 — 작은 값이 0 으로 보이지 않게 1달러 미만은 소수 넷째 자리까지 */
export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** "10/2 21:03" 처럼 짧은 날짜 · 시각 */
export function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatClock(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
