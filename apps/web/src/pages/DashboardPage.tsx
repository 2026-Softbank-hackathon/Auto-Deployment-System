import { followAppLink, type Navigate } from '../app/navigation';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { Koro } from '../components/ui/Koro';
import { StatusTape } from '../components/ui/StatusTape';
import { RedeployButton } from '../features/deployment-progress/RedeployButton';
import { DeploymentRow } from '../features/dashboard/DeploymentRow';
import { useDeploymentList, type DeploymentListItem } from '../features/dashboard/useDeploymentList';
import { isStalled } from '../features/dashboard/format';
import { deploymentStatusView } from '../features/deployment-status/status-view';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

function SleepingRailScene() {
  const { t } = useI18n();
  return <svg className="empty-scene" width="560" height="150" viewBox="0 0 560 150" role="img" aria-label={t.dashboard.emptyScene}>
    <line className="empty-scene__floor" x1="20" y1="142" x2="540" y2="142" />
    <rect className="empty-scene__pad-base" x="20" y="96" width="110" height="40" rx="12" />
    <rect className="empty-scene__pad" x="20" y="88" width="110" height="40" rx="12" />
    <path className="empty-scene__rail" d="M130 112 L480 112" />
    <circle className="empty-scene__stop" cx="220" cy="112" r="6" />
    <circle className="empty-scene__stop" cx="310" cy="112" r="6" />
    <circle className="empty-scene__stop" cx="400" cy="112" r="6" />
    <path className="empty-scene__cup" d="M486 98 H540 V110 A27 24 0 0 1 486 110 Z" />
    <ellipse className="empty-scene__shadow" cx="75" cy="88" rx="26" ry="4" />
    <Koro mood="sleepy" size={64} x={43} y={24} />
    <text className="empty-scene__z" x="104" y="30" fontSize="14">z</text>
    <text className="empty-scene__z empty-scene__z--small" x="116" y="18" fontSize="11">z</text>
  </svg>;
}

function EmptyState({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  return <section className="dashboard-empty" aria-labelledby="empty-deployments-title">
    <SleepingRailScene />
    <h2 id="empty-deployments-title">{t.dashboard.emptyTitle}</h2>
    <p>{t.dashboard.emptyCopy}</p>
    <DeployKeycap size="lg" href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.emptyCta}</DeployKeycap>
  </section>;
}

function Counts({ items, now }: { items: DeploymentListItem[]; now: number }) {
  const { t } = useI18n();
  const outcomes = items.map((item) => {
    const outcome = deploymentStatusView(item.status).outcome;
    return isStalled(outcome === 'active', item.createdAt, now) ? 'stalled' : outcome;
  });
  const count = (outcome: string) => outcomes.filter((value) => value === outcome).length;
  return <div className="dashboard-counts">
    <StatusTape tone="running">{t.dashboard.countActive(count('active'))}</StatusTape>
    <StatusTape tone="success">{t.dashboard.countSuccess(count('success'))}</StatusTape>
    <StatusTape tone="failed">{t.dashboard.countFailed(count('failed'))}</StatusTape>
    {count('stalled') > 0 && <StatusTape tone="waiting">{t.dashboard.countStalled(count('stalled'))}</StatusTape>}
    <span className="dashboard-counts__note">{t.dashboard.countBasis(items.length)}</span>
  </div>;
}

export function DashboardPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state, retry } = useDeploymentList();
  const hasItems = state.phase === 'ready' && state.items.length > 0;

  return <>
    <div className="page-head">
      <div><h1>{t.dashboard.title}</h1><p>{t.dashboard.description}</p></div>
      {hasItems && <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.newDeploy}</DeployKeycap>}
    </div>

    {state.phase === 'loading' && <p className="dashboard-status" role="status">{t.dashboard.loading}</p>}

    {state.phase === 'error' && <div className="notice error dashboard-error" role="alert">
      <strong>{t.dashboard.loadError}</strong><br />{errorMessage(state.error, t, t.errors.listFailed)}
      <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{t.dashboard.retry}</Keycap></div>
    </div>}

    {state.phase === 'ready' && state.items.length === 0 && <EmptyState onNavigate={onNavigate} />}

    {state.phase === 'ready' && state.items.length > 0 && <>
      <Counts items={state.items} now={state.loadedAt} />
      {state.partialFailures > 0 && <p className="dashboard-status">{t.dashboard.partialFailures(state.partialFailures)}</p>}
      <section className="deployment-list" aria-label={t.dashboard.listLabel}>
        {state.items.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} now={state.loadedAt} onNavigate={onNavigate}
          extraAction={['failed', 'stopped'].includes(deploymentStatusView(deployment.status).outcome)
            ? <RedeployButton compact variant="ghost" deploymentId={deployment.id} onStarted={(id) => onNavigate(`/deployments/${encodeURIComponent(id)}`)} /> : undefined} />)}
      </section>
    </>}
  </>;
}
