import { useEffect, useRef, useState } from 'react';
import { getDeploymentStatus } from '../../api/deployment-api';
import { followAppLink, type Navigate } from '../../app/navigation';
import type { Route } from '../../app/routes';
import { useI18n } from '../../i18n/I18nProvider';
import { displayProjectName, isStalled } from '../dashboard/format';
import { loadProjects } from '../dashboard/useProjectList';
import { deploymentStatusView, type DeploymentOutcome } from '../deployment-status/status-view';
import { usePreferences } from '../settings/preferences';
import { useSound } from '../sound/SoundProvider';

/** 진행 중인 배포가 있을 때 / 없을 때 다시 조회하는 간격. 전역 이벤트 스트림이 없어 앱 목록(각 앱의 최근 배포)을 다시 읽는다. */
const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;
const MAX_TOASTS = 3;

interface Toast { deploymentId: string; projectName: string; outcome: 'success' | 'failed' | 'stopped' }

/**
 * 어느 화면에 있든 배포가 끝나면 알려 준다 (#146).
 * 진행 중이던 배포가 성공 · 실패 · 중단으로 바뀐 것을 실제 상태 조회로 확인했을 때만 알린다.
 * 그 배포의 진행 · 결과 화면을 보고 있을 때는 화면이 이미 알려 주므로 띄우지 않는다.
 */
export function DeploymentNotifier({ route, onNavigate }: { route: Route; onNavigate: Navigate }) {
  const { t } = useI18n();
  const { play } = useSound();
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 환경설정에서 알림을 꺼도 목록 확인은 계속한다(대시보드에 바로 보여 줄 값을 채워 두기 위해). 알림과 효과음만 내지 않는다.
  const { preferences } = usePreferences();
  const notifyRef = useRef(preferences.notify);
  notifyRef.current = preferences.notify;
  /** 직전 조회에서 본 각 앱의 최근 배포 상태. 처음 조회는 기준만 잡고 알리지 않는다. */
  const seen = useRef<Map<string, { outcome: DeploymentOutcome; projectName: string }> | null>(null);
  const viewing = useRef<string | null>(null);
  viewing.current = route.page === 'progress' || route.page === 'result' ? route.deploymentId : null;

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    async function check() {
      let hasActive = false;
      try {
        const projects = await loadProjects();
        if (!active) return;
        const now = Date.now();
        const next = new Map<string, { outcome: DeploymentOutcome; projectName: string }>();
        for (const project of projects) {
          if (!project.latest) continue;
          const outcome = deploymentStatusView(project.latest.status).outcome;
          next.set(project.latest.deploymentId, { outcome, projectName: project.name });
          if (outcome === 'active' && !isStalled(true, project.latest.createdAt, now)) hasActive = true;
        }
        // 진행 중이던 배포가 끝나자마자 같은 앱에 새 배포가 시작되면 목록에서 밀려난다. 그 배포만 따로 상태를 묻는다.
        const pushedOut = [...(seen.current ?? [])].filter(([deploymentId, before]) => before.outcome === 'active' && !next.has(deploymentId));
        const recovered = await Promise.all(pushedOut.map(async ([deploymentId, before]) => {
          const status = await getDeploymentStatus(deploymentId).then((body) => body.status, () => null);
          return [deploymentId, { outcome: typeof status === 'string' ? deploymentStatusView(status).outcome : 'active', projectName: before.projectName }] as const;
        }));
        if (!active) return;
        const finished: Toast[] = [];
        for (const [deploymentId, current] of [...next, ...recovered]) {
          const before = seen.current?.get(deploymentId);
          if (before?.outcome === 'active' && (current.outcome === 'success' || current.outcome === 'failed' || current.outcome === 'stopped') && viewing.current !== deploymentId) {
            finished.push({ deploymentId, projectName: current.projectName, outcome: current.outcome });
          }
        }
        // 상태를 확인하지 못한 밀려난 배포는 다음 주기에 다시 묻는다.
        for (const [deploymentId, current] of recovered) if (current.outcome === 'active') next.set(deploymentId, current);
        seen.current = next;
        if (finished.length > 0 && notifyRef.current) {
          play(finished.some((toast) => toast.outcome === 'success') ? 'success' : 'failure');
          setToasts((current) => [...finished, ...current.filter((toast) => !finished.some((done) => done.deploymentId === toast.deploymentId))].slice(0, MAX_TOASTS));
        }
      } catch {
        // 알림은 부가 기능이라 조회 실패를 화면에 띄우지 않는다. 다음 주기에 다시 본다.
      }
      if (active) timer = window.setTimeout(() => { void check(); }, hasActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [play]);

  // 알림이 가리키는 배포 화면으로 들어가면 그 알림은 치운다.
  const viewingId = viewing.current;
  useEffect(() => {
    if (viewingId) setToasts((current) => current.filter((toast) => toast.deploymentId !== viewingId));
  }, [viewingId]);

  const dismiss = (deploymentId: string) => setToasts((current) => current.filter((toast) => toast.deploymentId !== deploymentId));

  return <div className="toast-stack" role="status" aria-live="polite">
    {preferences.notify && toasts.map((toast) => {
      const path = `/deployments/${encodeURIComponent(toast.deploymentId)}${toast.outcome === 'success' ? '/result' : ''}`;
      return <div key={toast.deploymentId} className={`toast is-${toast.outcome}`}>
        <div className="toast__body">
          <strong>{t.notify.title[toast.outcome]}</strong>
          <span>{displayProjectName(toast.projectName)} · {t.dashboard.deploymentNo(toast.deploymentId)}</span>
        </div>
        <a className="toast__link" href={path} onClick={(event) => { followAppLink(event, onNavigate); dismiss(toast.deploymentId); }}>{toast.outcome === 'success' ? t.dashboard.viewResult : t.notify.view}</a>
        <button type="button" className="toast__close" aria-label={t.notify.close} onClick={() => dismiss(toast.deploymentId)}>×</button>
      </div>;
    })}
  </div>;
}
