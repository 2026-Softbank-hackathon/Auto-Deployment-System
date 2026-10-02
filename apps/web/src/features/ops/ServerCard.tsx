import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { getOpsServer, type OpsServer } from '../../api/ops-api';
import { formatBytes, formatPercent } from './format';
import { OpsCard } from './OpsCard';
import { Sparkline } from './Sparkline';
import { useOpsResource } from './useOpsResource';

/** 마지막 측정이 이보다 오래되면 "수집 지연" (워커는 30초마다 잰다) */
const STALE_AFTER_SECONDS = 120;
const DISK_WARN = 80;
const MEMORY_WARN = 90;

function Stat({ label, value, sub, spark }: { label: string; value: ReactNode; sub?: ReactNode; spark?: ReactNode }) {
  return <div className="ops-stat">
    <span className="ops-stat__label">{label}</span>
    <strong className="ops-stat__value">{value}</strong>
    {sub && <span className="ops-stat__sub">{sub}</span>}
    {spark}
  </div>;
}

function ServerBody({ data }: { data: OpsServer }) {
  const { t } = useI18n();
  const copy = t.ops.server;
  const latest = data.latest;
  if (!latest) return <p className="dashboard-status">{copy.empty}</p>;

  const warned = new Set(data.warnings.map((warning) => warning.code));
  const series = data.series;
  const spark = (name: string, values: Array<number | null>, threshold?: number) => <div className="ops-stat__spark">
    <Sparkline values={values} label={copy.sparkLabel(name)} threshold={threshold} />
    <span>{copy.trend}</span>
  </div>;

  return <>
    {data.warnings.map((warning) => <div key={warning.code} className="notice error" role="alert">
      <strong>{copy.warnings[warning.code](warning.percent, warning.threshold)}</strong>
    </div>)}
    {latest.sampledSecondsAgo > STALE_AFTER_SECONDS && <div className="notice" role="status">{copy.stale(t.ops.duration(latest.sampledSecondsAgo))}</div>}

    <div className="ops-stats">
      <Stat label={copy.cpu}
        value={latest.cpuPercent === null ? copy.cpuPending : formatPercent(latest.cpuPercent)}
        sub={copy.measured(t.ops.duration(latest.sampledSecondsAgo))}
        spark={series.length > 0 && spark(copy.cpu, series.map((p) => p.cpu))} />
      <Stat label={copy.memory}
        value={<span className={warned.has('MEMORY_HIGH') ? 'is-bad' : undefined}>{formatPercent(latest.memPercent)}</span>}
        sub={`${formatBytes(latest.memUsedBytes)} / ${formatBytes(latest.memTotalBytes)}`}
        spark={series.length > 0 && spark(copy.memory, series.map((p) => p.mem), MEMORY_WARN)} />
      <Stat label={copy.disk}
        value={<span className={warned.has('DISK_HIGH') ? 'is-bad' : undefined}>{formatPercent(latest.diskPercent)}</span>}
        sub={`${formatBytes(latest.diskUsedBytes)} / ${formatBytes(latest.diskTotalBytes)}`}
        spark={series.length > 0 && spark(copy.disk, series.map((p) => p.disk), DISK_WARN)} />
      <Stat label={copy.load}
        value={<span className="ops-mono">{latest.load1.toFixed(2)} · {latest.load5.toFixed(2)} · {latest.load15.toFixed(2)}</span>}
        sub={copy.loadHint} />
      <Stat label={copy.buildCache}
        value={data.buildCache ? formatBytes(data.buildCache.bytes) : copy.noBuildCache}
        sub={copy.buildCacheHint} />
    </div>
  </>;
}

export function ServerCard() {
  const { t } = useI18n();
  const resource = useOpsResource(getOpsServer);
  return <OpsCard id="ops-server" title={t.ops.server.title} description={t.ops.server.description} resource={resource}>
    {(data) => <ServerBody data={data} />}
  </OpsCard>;
}
