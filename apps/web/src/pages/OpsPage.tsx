import type { Navigate } from '../app/navigation';
import { AiUsageCard } from '../features/ops/AiUsageCard';
import { DeploysCard } from '../features/ops/DeploysCard';
import { QueueCard } from '../features/ops/QueueCard';
import { ServerCard } from '../features/ops/ServerCard';
import { useI18n } from '../i18n/I18nProvider';

/**
 * 플랫폼 운영 (#308): 사용자 앱이 아니라 배포 시스템 자체의 상태 — 작업 큐 · 워커, 서버 자원, AI 비용, 자동 배포 기록.
 * 카드마다 따로 불러와서 한 API 가 실패해도 나머지는 보인다. 10초마다 새로 고치고 탭이 가려지면 멈춘다.
 */
export function OpsPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  return <>
    <div className="page-head">
      <div><h1>{t.ops.title}</h1><p>{t.ops.description}</p></div>
    </div>
    <div className="ops-grid">
      <QueueCard onNavigate={onNavigate} />
      <ServerCard />
      <AiUsageCard onNavigate={onNavigate} />
      <DeploysCard />
    </div>
  </>;
}
