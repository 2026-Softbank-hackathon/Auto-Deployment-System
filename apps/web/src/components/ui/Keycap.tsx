import type { AnchorHTMLAttributes, ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useSound } from '../../features/sound/SoundProvider';
import type { SoundName } from '../../features/sound/sound-engine';

interface KeycapOwnProps {
  /** primary: 어두운 키캡 · secondary: 흰 키캡 · ghost: 테두리 없는 텍스트 버튼 */
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  leading?: ReactNode;
  trailing?: ReactNode;
  /** 누를 때 재생할 효과음. false면 재생하지 않는다. */
  sound?: SoundName | false;
  className?: string;
  children: ReactNode;
}

type KeycapButtonProps = KeycapOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof KeycapOwnProps> & { href?: undefined };
type KeycapLinkProps = KeycapOwnProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof KeycapOwnProps> & { href: string };
export type KeycapProps = KeycapButtonProps | KeycapLinkProps;

/** 아래로 눌리는 키캡 버튼. href가 있으면 실제 <a>, 없으면 실제 <button>으로 렌더링한다. */
export function Keycap(props: KeycapProps) {
  const { play } = useSound();
  const { variant = 'primary', size = 'md', leading, trailing, sound = 'tap', className = '', children, ...rest } = props;
  const classes = `keycap keycap--${variant} keycap--${size} ${className}`;
  const content = <>{leading}<span className="keycap__label">{children}</span>{trailing}</>;

  if (rest.href !== undefined) {
    const { onClick, ...anchorProps } = rest as Omit<KeycapLinkProps, keyof KeycapOwnProps>;
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => { if (sound) play(sound); onClick?.(event); };
    return <a {...anchorProps} className={classes} onClick={handleClick}>{content}</a>;
  }

  const { onClick, type = 'button', ...buttonProps } = rest as Omit<KeycapButtonProps, keyof KeycapOwnProps>;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => { if (sound) play(sound); onClick?.(event); };
  return <button {...buttonProps} type={type} className={classes} onClick={handleClick}>{content}</button>;
}
