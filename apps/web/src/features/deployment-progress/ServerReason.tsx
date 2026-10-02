import { serverReason, useI18n } from '../../i18n/I18nProvider';
import { FailureDetail } from './FailureDetail';

/**
 * 서버가 거절한 사유 (#147). 본문은 현재 언어 문구(오류 코드별)이고, 서버 원문은 "자세한 오류 보기" 안에만 둔다.
 * known: 화면별로 더 알맞은 코드별 문구 (예: 재배포 · 앱 삭제).
 */
export function ServerReason({ error, fallback, known }: { error: unknown; fallback: string; known?: Partial<Record<string, string>> }) {
  const { t } = useI18n();
  const { text, detail } = serverReason(error, t, fallback, known);
  return <>{text}{detail && <FailureDetail detail={detail} />}</>;
}
