import type { EnvironmentSummary } from '../../api/deployment-api';
import { StatusTape } from '../../components/ui/StatusTape';
import { useI18n } from '../../i18n/I18nProvider';
import { relativeTime } from '../dashboard/format';

/** 온프레미스 Agent 상태: 온라인 / 오프라인(마지막 연결 시각) / 아직 등록 안 됨. 온라인 판정은 서버가 한다(최근 90초 안의 연락). */
export function AgentState({ connection, now }: { connection: EnvironmentSummary; now: number }) {
  const { t } = useI18n();
  const copy = t.connections.agent;
  const seen = connection.agentLastSeenAt ? <span className="agent-status__seen">{copy.lastSeen(relativeTime(connection.agentLastSeenAt, now, t))}</span> : null;
  return <span className="agent-status">
    {connection.agentOnline
      ? <StatusTape tone="success">{copy.online}</StatusTape>
      : <StatusTape tone={connection.agentLastSeenAt ? 'failed' : 'waiting'}>{connection.agentLastSeenAt ? copy.offline : copy.never}</StatusTape>}
    {seen}
  </span>;
}
