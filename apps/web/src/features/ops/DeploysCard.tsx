import type { MarbleTone } from '../../components/ui/Marble';
import { StatusTape } from '../../components/ui/StatusTape';
import { useI18n } from '../../i18n/I18nProvider';
import { getOpsDeploys, safeHttpsUrl, type OpsDeploy, type OpsDeployList, type OpsDeployStatus } from '../../api/ops-api';
import { formatBytes, formatBytesDelta, formatDateTime, shortSha } from './format';
import { OpsCard } from './OpsCard';
import { useOpsResource } from './useOpsResource';

const TONES: Record<OpsDeployStatus, MarbleTone> = { running: 'running', success: 'success', failed: 'failed', interrupted: 'waiting' };

function DiskCell({ deploy }: { deploy: OpsDeploy }) {
  const { diskUsedBeforeBytes: before, diskUsedAfterBytes: after, diskTotalBytes: total } = deploy;
  if (before === null && after === null) return <>—</>;
  return <span className="ops-disk">
    <span>{before === null ? '—' : formatBytes(before)} → {after === null ? '—' : formatBytes(after)}{total !== null && after !== null ? ` / ${formatBytes(total)}` : ''}</span>
    {before !== null && after !== null && <span className={`ops-delta${after < before ? ' is-good' : after > before ? ' is-warn' : ''}`}>{formatBytesDelta(after - before)}</span>}
  </span>;
}

function DeploysBody({ data }: { data: OpsDeployList }) {
  const { t } = useI18n();
  const copy = t.ops.deploys;
  const cols = copy.columns;
  if (data.items.length === 0) return <p className="dashboard-status">{copy.empty}</p>;

  return <div className="ops-table-wrap"><table className="ops-table" aria-label={copy.tableLabel}>
    <thead><tr>
      <th scope="col">{cols.status}</th>
      <th scope="col">{cols.commit}</th>
      <th scope="col" className="ops-num">{cols.duration}</th>
      <th scope="col">{cols.disk}</th>
      <th scope="col">{cols.run}</th>
      <th scope="col">{cols.started}</th>
    </tr></thead>
    <tbody>{data.items.map((deploy) => {
      const commitUrl = safeHttpsUrl(deploy.commitUrl);
      const runUrl = safeHttpsUrl(deploy.runUrl);
      const subject = deploy.commitSubject ?? copy.noSubject;
      const runLabel = deploy.runId ? copy.run(deploy.runId) : copy.noRun;
      return <tr key={deploy.id}>
        <td title={deploy.status === 'interrupted' ? copy.interruptedHint : undefined}>
          <StatusTape tone={TONES[deploy.status]} className={deploy.status === 'interrupted' ? 'status-tape--quiet' : ''}>{copy.status[deploy.status]}</StatusTape>
        </td>
        <td className="ops-commit">
          {commitUrl ? <a href={commitUrl} target="_blank" rel="noreferrer">{subject}</a> : <span>{subject}</span>}
          {deploy.commitSha && <code>{shortSha(deploy.commitSha)}</code>}
        </td>
        <td className="ops-num">{deploy.durationSeconds === null ? '—' : t.ops.duration(deploy.durationSeconds)}</td>
        <td><DiskCell deploy={deploy} /></td>
        <td className="ops-nowrap">{runUrl ? <a href={runUrl} target="_blank" rel="noreferrer">{runLabel}</a> : runLabel}</td>
        <td className="ops-nowrap">{formatDateTime(deploy.startedAt, t.locale)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}

export function DeploysCard() {
  const { t } = useI18n();
  const resource = useOpsResource(getOpsDeploys);
  return <OpsCard id="ops-deploys" title={t.ops.deploys.title} description={t.ops.deploys.description} resource={resource}>
    {(data) => <DeploysBody data={data} />}
  </OpsCard>;
}
