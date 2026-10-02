import { followAppLink, type Navigate } from '../../app/navigation';
import { StatusTape } from '../../components/ui/StatusTape';
import { useI18n } from '../../i18n/I18nProvider';
import { getOpsQueue, type OpsActiveJob, type OpsQueue, type OpsWorker } from '../../api/ops-api';
import { formatNumber, shortSha } from './format';
import { OpsCard } from './OpsCard';
import { useOpsResource } from './useOpsResource';

/** 이 시간보다 오래 기다린 작업은 눈에 띄게 */
const LONG_WAIT_SECONDS = 60;

function ActiveJobLink({ job, onNavigate }: { job: OpsActiveJob; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.ops.queue;
  if (job.deploymentId) {
    return <a href={`/deployments/${encodeURIComponent(job.deploymentId)}`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.deployment(job.deploymentId)}</a>;
  }
  if (job.projectId) {
    return <a href={`/projects/${encodeURIComponent(job.projectId)}`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.project(job.projectId)}</a>;
  }
  return <span className="ops-muted">—</span>;
}

function WorkerItem({ worker }: { worker: OpsWorker }) {
  const { t } = useI18n();
  const copy = t.ops.queue;
  const tone = !worker.online ? 'failed' : worker.draining ? 'waiting' : 'success';
  const label = !worker.online ? copy.offline : worker.draining ? copy.draining : copy.online;
  return <li className="ops-worker">
    <div className="ops-worker__head">
      <StatusTape tone={tone}>{label}</StatusTape>
      <code>{worker.hostname}</code>
      <span className="ops-muted">{worker.commit ? <>{copy.commit} <code>{shortSha(worker.commit)}</code></> : copy.unknownCommit}</span>
    </div>
    <p className="ops-worker__facts">
      <span>{copy.uptime(t.ops.duration(worker.uptimeSeconds))}</span>
      <span>{copy.lastSeen(t.ops.duration(worker.lastSeenSecondsAgo))}</span>
      <span>{copy.jobs(worker.activeJobs)}</span>
    </p>
    {worker.online && worker.draining && <p className="ops-muted">{copy.drainingHint}</p>}
  </li>;
}

function QueueBody({ data, onNavigate }: { data: OpsQueue; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.ops.queue;
  const cols = copy.columns;
  const n = (value: number) => formatNumber(value, t.locale);
  const anyOnline = data.workers.some((worker) => worker.online);

  return <>
    {!anyOnline && <div className="notice error" role="alert">{data.workers.length === 0 ? copy.noWorkers : copy.noOnlineWorker}</div>}

    {data.queues.length === 0
      ? <p className="dashboard-status">{copy.noQueues}</p>
      : <div className="ops-table-wrap"><table className="ops-table" aria-label={copy.tableLabel}>
        <thead><tr>
          <th scope="col">{cols.name}</th>
          <th scope="col" className="ops-num">{cols.created}</th>
          <th scope="col" className="ops-num">{cols.retry}</th>
          <th scope="col" className="ops-num">{cols.active}</th>
          <th scope="col" className="ops-num">{cols.completed}</th>
          <th scope="col" className="ops-num">{cols.failed}</th>
          <th scope="col" className="ops-num">{cols.oldest}</th>
        </tr></thead>
        <tbody>{data.queues.map((queue) => <tr key={queue.name}>
          <th scope="row"><span className="ops-queue-name">{copy.names[queue.name] ?? queue.name}<code>{queue.name}</code></span></th>
          <td className="ops-num">{n(queue.created)}</td>
          <td className={`ops-num${queue.retry > 0 ? ' is-warn' : ''}`}>{n(queue.retry)}</td>
          <td className={`ops-num${queue.active > 0 ? ' is-active' : ''}`}>{n(queue.active)}</td>
          <td className="ops-num">{n(queue.completed24h)}</td>
          <td className={`ops-num${queue.failed24h > 0 ? ' is-bad' : ''}`}>{n(queue.failed24h)}</td>
          <td className={`ops-num${(queue.oldestWaitingSeconds ?? 0) > LONG_WAIT_SECONDS ? ' is-warn' : ''}`}>
            {queue.oldestWaitingSeconds === null ? '—' : t.ops.duration(queue.oldestWaitingSeconds)}
          </td>
        </tr>)}</tbody>
      </table></div>}

    <div className="ops-split">
      <div className="ops-sub">
        <h3>{copy.activeTitle}</h3>
        {data.activeJobs.length === 0
          ? <p className="dashboard-status">{copy.noActive}</p>
          : <ul className="ops-list">{data.activeJobs.map((job) => <li key={job.id} className="ops-job">
            <span className="ops-queue-name">{copy.names[job.name] ?? job.name}<code>{job.name}</code></span>
            <ActiveJobLink job={job} onNavigate={onNavigate} />
            <span className="ops-muted">{copy.running(t.ops.duration(job.runningSeconds))}{job.retryCount > 0 ? ` · ${copy.retryCount(job.retryCount)}` : ''}</span>
          </li>)}</ul>}
      </div>
      <div className="ops-sub">
        <h3>{copy.workersTitle}</h3>
        {data.workers.length > 0 && <ul className="ops-list">{data.workers.map((worker) => <WorkerItem key={worker.workerId} worker={worker} />)}</ul>}
      </div>
    </div>
  </>;
}

export function QueueCard({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const resource = useOpsResource(getOpsQueue);
  return <OpsCard id="ops-queue" title={t.ops.queue.title} description={t.ops.queue.description} resource={resource}>
    {(data) => <QueueBody data={data} onNavigate={onNavigate} />}
  </OpsCard>;
}
