import { useSound } from '../../features/sound/SoundProvider';

/** 헤더 오른쪽 사운드 스위치. 이름은 "SOUND"로 고정하고 켜짐/꺼짐은 aria-checked로 전달한다. */
export function SoundToggle() {
  const { enabled, setEnabled } = useSound();
  return <button type="button" role="switch" aria-checked={enabled} className="sound-toggle" onClick={() => setEnabled(!enabled)}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9 H8 L13 5 V19 L8 15 H4 Z" />
      {enabled
        ? <><path d="M16.5 9 A4 4 0 0 1 16.5 15" /><path d="M19 6.5 A8 8 0 0 1 19 17.5" /></>
        : <><path d="M16 9 L22 15" /><path d="M22 9 L16 15" /></>}
    </svg>
    <span>SOUND</span><span aria-hidden="true">{enabled ? 'ON' : 'OFF'}</span>
  </button>;
}
