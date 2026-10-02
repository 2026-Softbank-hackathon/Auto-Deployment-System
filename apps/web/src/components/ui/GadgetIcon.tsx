import { useI18n } from '../../i18n/I18nProvider';

export type GadgetKind = 'source' | 'analyze' | 'build' | 'provision' | 'deploy' | 'verify' | 'done';

function Paths({ kind }: { kind: GadgetKind }) {
  switch (kind) {
    case 'source': return <><path d="M3 19 H8 L21 8" /><circle cx="6" cy="15.5" r="2.5" /></>;
    case 'analyze': return <><path d="M2 20 H22" /><path d="M4 20 L8 6" /><path d="M10 20 L14 6" /><path d="M16 20 L20 6" /></>;
    case 'build': return <path d="M4 5 H20 L14 12 V19 H10 V12 Z" />;
    case 'provision': return <><ellipse cx="12" cy="12" rx="9" ry="6" /><ellipse cx="12" cy="12.5" rx="5.5" ry="3.4" /><ellipse cx="12" cy="13" rx="2" ry="1.1" /></>;
    case 'deploy': return <><path d="M4 13 Q12 19 20 13" /><path d="M6 14 V20" /><path d="M18 14 V20" /><path d="M12 11 V3" /><path d="M9 6 L12 3 L15 6" /></>;
    case 'verify': return <><path d="M12 4 V19" /><path d="M7 19 H17" /><path d="M5 8 H19" /><path d="M5 8 L3 13 H7 Z" /><path d="M19 8 L17 13 H21 Z" /></>;
    case 'done': return <path d="M4 10 H20 V13 A8 7 0 0 1 4 13 Z" />;
  }
}

/** 단계 아이콘 (소스=출발대, 분석=도미노, 빌드=깔때기, 인프라 준비=나선, 배포=도약대, 검증=저울, 완료=컵). 색은 currentColor. */
export function GadgetIcon({ kind, size = 20, label }: { kind: GadgetKind; size?: number; label?: boolean }) {
  const { t } = useI18n();
  return <svg className="gadget-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
    role={label ? 'img' : undefined} aria-label={label ? t.gadgets[kind] : undefined} aria-hidden={label ? undefined : true}>
    <Paths kind={kind} />
  </svg>;
}
