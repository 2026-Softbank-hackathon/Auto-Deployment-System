/**
 * 효과음 — Web Audio API로 즉석 합성한다. 음원 파일·네트워크가 필요 없다.
 * AudioContext는 브라우저 자동 재생 정책 때문에 첫 사용자 동작(클릭) 때 만든다.
 */
export type SoundName = 'tap' | 'start' | 'success' | 'failure' | 'toggle';

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
