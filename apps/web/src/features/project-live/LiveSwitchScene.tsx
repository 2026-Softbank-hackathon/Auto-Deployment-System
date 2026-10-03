import { useEffect, useRef, type CSSProperties } from 'react';
import { Koro } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import { House } from '../deployment-progress/DeployScene';
import { useSound } from '../sound/SoundProvider';
import type { LiveSwitch } from './useProjectLive';

/**
 * 온프레미스 → AWS 자동 전환(#349)을 확인했을 때 한 번 재생하는 장면.
 *
 * 이미 일어난 일의 재현이다. 서버는 전환 이유나 진행 상태를 주지 않고, 화면은 전환이 끝난 뒤 live 가 바뀐 것만 안다.
 * 그래서 "감지 중 · 복구 중" 같은 진행 표시는 없고, 온프레미스 쪽은 "지금은 서비스하지 않는다"는 뜻으로 어둡게만 그린다
 * (서버가 죽었다고 단정하는 그림은 넣지 않는다 — 온프레미스 배포는 여전히 성공 상태다).
 *
 * 그림은 배포 진행 장면(DeployScene)의 요소를 그대로 쓴다: 집 = 컨테이너 이미지, 구름 = AWS, 서버 = 온프레미스, LIVE 표지.
 * 두 집이 같은 이미지라는 것은 화면이 확인할 수 없으므로 이름표는 붙이지 않고, 서버가 알려 준 배포 번호만 적는다.
 *
 * 순서(약 5초, 한 번): 코로가 온프레미스 집 옆에 있고 LIVE 는 그 집 위 → 온프레미스 쪽 불이 꺼지자 코로가 놀람(느낌표 · 펄쩍)
 *   → 코로가 LIVE 표지와 함께 구름 위 집으로 건너감 → LIVE 가 내려앉고 코로가 웃음.
 * 움직임 줄이기 설정에서는 마지막 모습만 보여 준다. 반복하지 않는다.
 */
const WIDTH = 760;
const HEIGHT = 256;
const GROUND = 206;
/** 집의 바닥 중심: 서버 옆 · 구름 위 */
const ONPREM_HOUSE = [176, GROUND] as const;
const CLOUD_TOP = 156;
const AWS_HOUSE = [540, CLOUD_TOP] as const;
/** 집 높이(3층 + 지붕) 위에 LIVE 표지를 띄우는 높이 */
const LIVE_LIFT = 78 + 30 + 14;
/** LIVE 표지가 구름 위 집에 내려앉는 시각 (CSS 의 ls-fly 와 맞춘다) */
const LANDING_MS = 4000;
const KORO_SIZE = 56;
/** 코로의 왼쪽 위 좌표: 온프레미스 집 옆 → 구름 위 집 옆 */
const KORO_ONPREM = [236, GROUND - KORO_SIZE] as const;
const KORO_AWS = [616, CLOUD_TOP - KORO_SIZE] as const;

export function LiveSwitchScene({ liveSwitch }: { liveSwitch: LiveSwitch }) {
  const { t } = useI18n();
  const { play } = useSound();

  // LIVE 표지가 내려앉을 때 한 번 소리를 낸다. 움직임 줄이기 설정에서는 장면이 바로 마지막 모습이므로 곧바로 낸다.
  // 전환 한 건에 한 번만 울리도록(소리 설정을 바꿔도 다시 울리지 않게) play 는 ref 로 읽는다.
  const playRef = useRef(play);
  playRef.current = play;
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timer = window.setTimeout(() => playRef.current('check'), reduced ? 0 : LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [liveSwitch.toDeploymentId]);

  const from = t.dashboard.deploymentNo(liveSwitch.fromDeploymentId);
  const to = t.dashboard.deploymentNo(liveSwitch.toDeploymentId);
  const liveStyle = {
    '--ls-from-x': `${ONPREM_HOUSE[0]}px`, '--ls-from-y': `${ONPREM_HOUSE[1] - LIVE_LIFT}px`,
    '--ls-to-x': `${AWS_HOUSE[0]}px`, '--ls-to-y': `${AWS_HOUSE[1] - LIVE_LIFT}px`,
  } as CSSProperties;

  const runnerStyle = {
    '--ls-from-x': `${KORO_ONPREM[0]}px`, '--ls-from-y': `${KORO_ONPREM[1]}px`,
    '--ls-to-x': `${KORO_AWS[0]}px`, '--ls-to-y': `${KORO_AWS[1]}px`,
  } as CSSProperties;

  return <svg className="live-switch-scene" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t.projects.liveSwitch.scene(from, to)}>
    <line className="scene-floor" x1="24" y1={GROUND} x2="330" y2={GROUND} />

    {/* 온프레미스: 서버와 그 옆의 집. 재생이 진행되면 불이 꺼진다(지금은 여기서 서비스하지 않는다) */}
    <g className="ls-onprem">
      <rect className="jr-paper" x="50" y={GROUND - 110} width="50" height="110" rx="5" />
      {[GROUND - 88, GROUND - 66, GROUND - 44, GROUND - 22].map((y) => <g key={y}>
        <path className="jr-line" d={`M58 ${y} H80`} />
        <circle className="jr-led" cx="90" cy={y} r="3" />
      </g>)}
      <text className="jr-sign" x="75" y={GROUND - 120} textAnchor="middle">ON-PREM</text>
      <g transform={`translate(${ONPREM_HOUSE[0]} ${ONPREM_HOUSE[1]})`}><House floors={3} roofed windows="off" tag={null} /></g>
      <text className="ls-number" x={ONPREM_HOUSE[0]} y={GROUND + 22} textAnchor="middle">{from}</text>
    </g>

    {/* 가는 길 */}
    <path className="jr-route" d={`M${ONPREM_HOUSE[0] + 60} ${GROUND - 96} Q 360 20 ${AWS_HOUSE[0] - 62} ${CLOUD_TOP - 96}`} />

    {/* AWS: 구름과 그 위의 집. 처음부터 불이 켜진 채 대기하고 있다 */}
    <g className="ls-aws">
      <ellipse className="jr-cloud" cx="470" cy={CLOUD_TOP + 56} rx="46" ry="22" />
      <ellipse className="jr-cloud" cx="560" cy={CLOUD_TOP + 64} rx="56" ry="24" />
      <ellipse className="jr-cloud" cx="650" cy={CLOUD_TOP + 56} rx="46" ry="22" />
      <path className="jr-cloud" d={`M430 ${CLOUD_TOP} H690 A30 30 0 0 1 690 ${CLOUD_TOP + 60} H430 A30 30 0 0 1 430 ${CLOUD_TOP} Z`} />
      <text className="jr-sign" x="560" y={CLOUD_TOP + 40} textAnchor="middle">AWS</text>
      <g transform={`translate(${AWS_HOUSE[0]} ${AWS_HOUSE[1]})`}><House floors={3} roofed windows="on" tag={null} /></g>
      <text className="ls-number" x="466" y={CLOUD_TOP + 40} textAnchor="middle">{to}</text>
    </g>

    {/* LIVE 표지: 온프레미스 집 위에서 구름 위 집으로 옮겨 간다 */}
    <g className="ls-live" style={liveStyle}>
      <rect x="-25" y="-18" width="50" height="18" rx="9" />
      <path d="M-5 0 L0 7 L5 0 Z" />
      <text x="0" y="-5" textAnchor="middle">LIVE</text>
    </g>

    {/* 코로 ① 평소처럼 온프레미스 집 옆에 서 있다 (불이 꺼지기 전까지) */}
    <g className="ls-calm"><Koro mood="normal" size={KORO_SIZE} x={KORO_ONPREM[0]} y={KORO_ONPREM[1]} /></g>
    {/* 코로 ② 불이 꺼지자 놀라서 펄쩍 뛰고, LIVE 표지와 함께 구름으로 건너간다 */}
    <g className="ls-runner" style={runnerStyle}>
      <g className="ls-runner__hop">
        <Koro mood="flustered" size={KORO_SIZE} x={0} y={0} />
        <text className="ls-bang" x={KORO_SIZE + 2} y="6">!</text>
      </g>
    </g>
    {/* 코로 ③ 전환이 끝난 구름 위에서 웃는다 (마지막 모습) */}
    <g className="ls-koro"><Koro mood="happy" size={KORO_SIZE} x={KORO_AWS[0]} y={KORO_AWS[1]} /></g>
  </svg>;
}
