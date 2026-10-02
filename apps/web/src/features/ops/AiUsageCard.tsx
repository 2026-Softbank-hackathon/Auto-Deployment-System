import { followAppLink, type Navigate } from '../../app/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { getOpsAiUsage, type OpsAiTotals, type OpsAiUsage } from '../../api/ops-api';
import { formatDateTime, formatNumber, formatUsd } from './format';
import { OpsCard } from './OpsCard';
import { useOpsResource } from './useOpsResource';

function TotalTile({ label, totals }: { label: string; totals: OpsAiTotals }) {
  const { t } = useI18n();
  const copy = t.ops.ai;
  const n = (value: number) => formatNumber(value, t.locale);
  return <div className="ops-stat">
    <span className="ops-stat__label">{label}</span>
    <strong className="ops-stat__value">{formatUsd(totals.costUsd)}</strong>
    <span className="ops-stat__sub">{copy.calls(totals.calls)}</span>
    <span className="ops-stat__sub">{copy.tokens(n(totals.inputTokens), n(totals.outputTokens))}</span>
  </div>;
}

function BreakdownTable({ caption, firstColumn, rows }: { caption: string; firstColumn: string; rows: Array<OpsAiTotals & { key: string; label: string }> }) {
  const { t } = useI18n();
  const cols = t.ops.ai.columns;
  const n = (value: number) => formatNumber(value, t.locale);
  return <div className="ops-sub">
    <h3>{caption}</h3>
    <div className="ops-table-wrap"><table className="ops-table">
      <thead><tr>
        <th scope="col">{firstColumn}</th>
        <th scope="col" className="ops-num">{cols.calls}</th>
        <th scope="col" className="ops-num">{cols.input}</th>
        <th scope="col" className="ops-num">{cols.output}</th>
        <th scope="col" className="ops-num">{cols.cost}</th>
      </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.key}>
        <th scope="row">{row.label}</th>
        <td className="ops-num">{n(row.calls)}</td>
        <td className="ops-num">{n(row.inputTokens)}</td>
        <td className="ops-num">{n(row.outputTokens)}</td>
        <td className="ops-num">{formatUsd(row.costUsd)}</td>
      </tr>)}</tbody>
    </table></div>
  </div>;
}

function AiUsageBody({ data, onNavigate }: { data: OpsAiUsage; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.ops.ai;
  const cols = copy.columns;
  const n = (value: number) => formatNumber(value, t.locale);

  return <>
    <p className="notice ops-note">{copy.estimateNote}</p>
    <div className="ops-stats ops-stats--two">
      <TotalTile label={copy.today} totals={data.today} />
      <TotalTile label={copy.last7d} totals={data.last7d} />
    </div>

    {data.last7d.calls === 0
      ? <p className="dashboard-status">{copy.noUsage}</p>
      : <div className="ops-split">
        <BreakdownTable caption={copy.byModel} firstColumn={cols.model}
          rows={data.byModel.map((row) => ({ ...row, key: row.model, label: row.model }))} />
        <BreakdownTable caption={copy.byPurpose} firstColumn={cols.purpose}
          rows={data.byPurpose.map((row) => ({ ...row, key: row.purpose, label: copy.purposes[row.purpose] ?? row.purpose }))} />
      </div>}

    <div className="ops-sub">
      <h3>{copy.recent}</h3>
      {data.recent.length === 0
        ? <p className="dashboard-status">{copy.noRecent}</p>
        : <div className="ops-table-wrap"><table className="ops-table">
          <thead><tr>
            <th scope="col">{cols.time}</th>
            <th scope="col">{cols.purpose}</th>
            <th scope="col">{cols.model}</th>
            <th scope="col" className="ops-num">{cols.input}</th>
            <th scope="col" className="ops-num">{cols.output}</th>
            <th scope="col" className="ops-num">{cols.cost}</th>
            <th scope="col">{cols.deployment}</th>
          </tr></thead>
          <tbody>{data.recent.map((call) => <tr key={call.id}>
            <td className="ops-nowrap">{formatDateTime(call.createdAt, t.locale)}</td>
            <td className="ops-nowrap">{copy.purposes[call.purpose] ?? call.purpose}</td>
            <td><code>{call.model}</code></td>
            <td className="ops-num">{n(call.inputTokens)}</td>
            <td className="ops-num">{n(call.outputTokens)}</td>
            <td className="ops-num">{formatUsd(call.costUsd)}</td>
            <td className="ops-nowrap">{call.deploymentId
              ? <a href={`/deployments/${encodeURIComponent(call.deploymentId)}`} onClick={(event) => followAppLink(event, onNavigate)}>{t.ops.queue.deployment(call.deploymentId)}</a>
              : '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </div>
  </>;
}

export function AiUsageCard({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const resource = useOpsResource(getOpsAiUsage);
  return <OpsCard id="ops-ai" title={t.ops.ai.title} description={t.ops.ai.description} resource={resource}>
    {(data) => <AiUsageBody data={data} onNavigate={onNavigate} />}
  </OpsCard>;
}
