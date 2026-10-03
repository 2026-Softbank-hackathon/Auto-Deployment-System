import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Keycap } from '../components/ui/Keycap';
import { useI18n } from '../i18n/I18nProvider';

interface BoundaryProps {
  /** 주소가 바뀌면 오류 화면을 걷고 새 화면을 그린다 */
  resetKey: string;
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('화면을 그리다 오류가 났습니다.', error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}

/**
 * 화면을 그리다 예외가 나도 앱 전체가 흰 화면이 되지 않게 막는다.
 * 사이드바 · 머리말은 그대로 두고 본문 자리에만 안내를 보여 주며, 다시 시도하거나 대시보드로 갈 수 있다.
 */
export function ErrorBoundary({ resetKey, onHome, children }: { resetKey: string; onHome: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const copy = t.errors.crashed;
  return <Boundary resetKey={resetKey} fallback={(retry) => <div className="notice error" role="alert">
    <strong>{copy.title}</strong><br />{copy.copy}
    <div className="page-actions">
      <Keycap variant="secondary" onClick={retry}>{copy.retry}</Keycap>
      <Keycap variant="ghost" onClick={onHome}>{copy.home}</Keycap>
    </div>
  </div>}>{children}</Boundary>;
}
