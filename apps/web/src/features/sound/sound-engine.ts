/**
 * 효과음 — Web Audio API로 즉석 합성한다. 음원 파일·네트워크가 필요 없다.
 * AudioContext는 브라우저 자동 재생 정책 때문에 첫 사용자 동작(클릭) 때 만든다.
 */
export type SoundName = 'tap' | 'start' | 'success' | 'failure' | 'toggle'
  // 배포 여정 장면 — 단계가 바뀌어 코로가 새 일을 시작할 때 한 번씩
  | 'scan' | 'hammer' | 'floor' | 'warehouse' | 'wrench' | 'takeoff' | 'roll' | 'robot' | 'parachute' | 'check';

interface Note { frequency: number; at: number; duration: number; type: OscillatorType; gain: number; slideTo?: number }

const cues: Record<SoundName, Note[]> = {
  // 키캡이 바닥에 닿는 짧은 딸깍
  tap: [{ frequency: 520, slideTo: 300, at: 0, duration: 0.05, type: 'triangle', gain: 0.18 }],
  // 코로가 출발대에서 굴러 내려가는 상승음
  start: [
    { frequency: 392, at: 0, duration: 0.09, type: 'triangle', gain: 0.16 },
    { frequency: 523, at: 0.08, duration: 0.09, type: 'triangle', gain: 0.16 },
    { frequency: 659, at: 0.16, duration: 0.09, type: 'triangle', gain: 0.16 },
    { frequency: 784, at: 0.24, duration: 0.16, type: 'triangle', gain: 0.16 },
  ],
  // 컵에 착지하는 두 음 차임
  success: [
    { frequency: 1047, at: 0, duration: 0.18, type: 'sine', gain: 0.2 },
    { frequency: 1568, at: 0.12, duration: 0.36, type: 'sine', gain: 0.18 },
  ],
  // 레일 아래로 떨어지는 하강음
  failure: [
    { frequency: 330, slideTo: 220, at: 0, duration: 0.2, type: 'triangle', gain: 0.18 },
    { frequency: 220, slideTo: 147, at: 0.18, duration: 0.3, type: 'triangle', gain: 0.16 },
  ],
  toggle: [{ frequency: 880, at: 0, duration: 0.06, type: 'sine', gain: 0.14 }],
  // 돋보기로 설계도를 훑는 가벼운 세 음
  scan: [
    { frequency: 880, at: 0, duration: 0.06, type: 'sine', gain: 0.1 },
    { frequency: 988, at: 0.09, duration: 0.06, type: 'sine', gain: 0.1 },
    { frequency: 1175, at: 0.18, duration: 0.1, type: 'sine', gain: 0.1 },
  ],
  // 망치질 두 번
  hammer: [
    { frequency: 190, slideTo: 90, at: 0, duration: 0.07, type: 'triangle', gain: 0.22 },
    { frequency: 190, slideTo: 90, at: 0.18, duration: 0.07, type: 'triangle', gain: 0.22 },
  ],
  // 집의 한 층이 올라가는 짧은 상승음
  floor: [{ frequency: 440, slideTo: 660, at: 0, duration: 0.09, type: 'triangle', gain: 0.14 }],
  // 창고 문이 드르륵 올라가는 소리
  warehouse: [{ frequency: 110, slideTo: 220, at: 0, duration: 0.32, type: 'sawtooth', gain: 0.07 }],
  // 렌치를 돌리는 딸깍 네 번
  wrench: [0, 0.07, 0.14, 0.21].map((at) => ({ frequency: 1200, at, duration: 0.025, type: 'square' as OscillatorType, gain: 0.05 })),
  // 비행기가 떠오르는 상승음
  takeoff: [
    { frequency: 150, slideTo: 620, at: 0, duration: 0.7, type: 'sawtooth', gain: 0.06 },
    { frequency: 300, slideTo: 900, at: 0.1, duration: 0.6, type: 'sine', gain: 0.08 },
  ],
  // 에이전트 로봇이 일을 넘겨받고 내는 삑삑
  robot: [
    { frequency: 660, at: 0, duration: 0.07, type: 'square', gain: 0.05 },
    { frequency: 990, at: 0.1, duration: 0.1, type: 'square', gain: 0.05 },
  ],
  // 로봇 바퀴가 구르는 낮은 네 박
  roll: [0, 0.11, 0.22, 0.33].map((at) => ({ frequency: 130, slideTo: 100, at, duration: 0.07, type: 'triangle' as OscillatorType, gain: 0.16 })),
  // 낙하산으로 내려오는 하강 휘파람과 펼쳐지는 소리
  parachute: [
    { frequency: 1400, slideTo: 520, at: 0, duration: 0.6, type: 'sine', gain: 0.1 },
    { frequency: 320, slideTo: 200, at: 0.56, duration: 0.12, type: 'triangle', gain: 0.14 },
  ],
  // 점검표에 체크하는 두 음
  check: [
    { frequency: 1320, at: 0, duration: 0.07, type: 'sine', gain: 0.12 },
    { frequency: 1760, at: 0.08, duration: 0.13, type: 'sine', gain: 0.12 },
  ],
};

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { context = new Ctor(); } catch { return null; }
  return context;
}

export function playCue(name: SoundName): void {
  const ctx = audioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const start = ctx.currentTime + 0.01;
  for (const note of cues[name]) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const noteStart = start + note.at;
    const noteEnd = noteStart + note.duration;
    oscillator.type = note.type;
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    if (note.slideTo) oscillator.frequency.exponentialRampToValueAtTime(note.slideTo, noteEnd);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(note.gain, noteStart + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.02);
  }
}
