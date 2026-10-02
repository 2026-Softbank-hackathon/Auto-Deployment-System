import type { ReactNode } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { formatClock } from './format';
import type { OpsResource } from './useOpsResource';

/**
 * 운영 화면 카드 하나 — 제목 · 설명 · 마지막 갱신 시각과 불러오는 중 · 오류 상태.
 * 새로 고침이 실패하면 마지막으로 받은 값을 그대로 두고 작은 안내만 붙인다.
 */
export function OpsCard<T extends object>({ id, title, description, resource, children }: {
  id: string;
  title: string;
  description: string;
  resource: OpsResource<T>;
  children: (data: T) => ReactNode;
}) {
  const { t } = useI18n();
  const copy = t.ops;
  const { data, error, loading, retry } = resource;
  const headingId = `${id}-title`;
  const generatedAt = data !== null && 'generatedAt' in data && typeof data.generatedAt === 'string' ? data.generatedAt : null;

  return <section className="ops-card" aria-labelledby={headingId}>
    <header className="ops-card__head">
      <div>
        <h2 id={headingId}>{title}</h2>
        <p>{description}</p>
      </div>
      {generatedAt && <span className="ops-card__updated">{copy.updated(formatClock(generatedAt, t.locale))}</span>}
    </header>
    {data === null && loading && <p className="dashboard-status" role="status">{copy.loading}</p>}
    {data === null && !loading && error !== null && <div className="notice error" role="alert">
      <strong>{copy.loadError}</strong> {errorMessage(error, t, copy.loadError)}
      <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{copy.retry}</Keycap></div>
    </div>}
    {data !== null && error !== null && <p className="ops-card__stale" role="status">{copy.refreshError} ({errorMessage(error, t, copy.loadError)})</p>}
    {data !== null && children(data)}
  </section>;
}
