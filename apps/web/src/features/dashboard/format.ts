import type { Messages } from '../../i18n/ko';

/** 원클릭 흐름이 프로젝트 이름에 붙인 중복 방지용 타임스탬프(-1727…)를 표시에서만 뗀다. */
export function displayProjectName(name: string): string {
  return name.replace(/-\d{13}$/, '') || name;
}

export function relativeTime(iso: string, now: number, t: Messages): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.time.hoursAgo(hours);
  if (hours < 48) return t.time.yesterday;
  return new Date(iso).toLocaleDateString(t.locale, { month: 'short', day: 'numeric' });
}

/** 백엔드의 환경 락 임대 시간 (apps/api approval-service: 2시간). 진행 중인 채로 이 시간을 넘긴 배포는 멈춘 것으로 본다. */
export const STALLED_AFTER_MS = 2 * 60 * 60 * 1000;

/** 끝나지 않은 채 락 임대 시간을 넘겼는지. 진행 여부를 추정하는 게 아니라 "시작한 지 2시간이 넘었다"는 사실만 본다. */
export function isStalled(active: boolean, createdAtIso: string, now: number): boolean {
  return active && now - Date.parse(createdAtIso) > STALLED_AFTER_MS;
}

/** 실제 시각 두 개의 차이만 표시한다. m:ss, 1시간 이상은 h:mm:ss */
export function elapsed(fromIso: string, toMs: number): string {
  const total = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

/** 백엔드가 준 공개 주소 중 http(s)만 링크로 쓴다. */
export function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try { return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}
