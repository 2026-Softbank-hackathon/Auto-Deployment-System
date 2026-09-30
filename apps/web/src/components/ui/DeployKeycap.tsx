import { Keycap, type KeycapProps } from './Keycap';
import { Koro } from './Koro';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type DeployKeycapProps = DistributiveOmit<KeycapProps, 'variant' | 'leading'> & {
  /** 요청 처리 중. 누를 수 없지만 비활성(회색)과 구분해 어두운 키캡을 유지한다. */
  busy?: boolean;
};

/** 배포 버튼 전용 키캡. 왼쪽 원형 구멍에 코로가 살짝 보이고, 비활성이면 회색 + 코로가 눈을 감는다. */
export function DeployKeycap({ busy = false, className = '', ...props }: DeployKeycapProps) {
  const isButton = props.href === undefined;
  const disabled = isButton && Boolean('disabled' in props && props.disabled);
  const mood = busy ? 'happy' : disabled ? 'sleepy' : 'normal';
  const well = <span className="deploy-keycap__well" aria-hidden="true"><Koro mood={mood} size={34} /></span>;
  const buttonState = isButton ? { disabled: disabled || busy, 'aria-busy': busy || undefined } : {};
  return <Keycap {...(props as KeycapProps)} {...buttonState} variant="primary" leading={well}
    className={`deploy-keycap ${busy ? 'deploy-keycap--busy' : ''} ${className}`} />;
}
