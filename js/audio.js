// Tiny WebAudio sound effects. No asset files.

let ctx = null;
let muted = false;

export function initAudio() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

export const setMuted = (m) => { muted = m; };
export const isMuted = () => muted;

function tone(freq, start, dur, { type = 'sine', gain = 0.08, slideTo = null } = {}) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const SFX = {
  orb: () => tone(880, 0, 0.1, { type: 'triangle', slideTo: 1320 }),
  gold: () => { tone(988, 0, 0.1, { type: 'triangle' }); tone(1318, 0.08, 0.16, { type: 'triangle' }); },
  step: () => { tone(660, 0, 0.12, { type: 'square', gain: 0.04 }); tone(880, 0.14, 0.18, { type: 'square', gain: 0.04 }); },
  warn: () => tone(440, 0, 0.15, { type: 'square', gain: 0.03 }),
  segment: () => { tone(523, 0, 0.12); tone(659, 0.1, 0.12); tone(784, 0.2, 0.2); },
  win: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.09, 0.2, { type: 'triangle' })); },
  level: () => { [392, 523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.1, 0.25, { type: 'triangle' })); },
  combo: () => tone(520, 0, 0.18, { type: 'sawtooth', gain: 0.04, slideTo: 1040 }),
  ach: () => { tone(784, 0, 0.12, { type: 'triangle' }); tone(1175, 0.12, 0.3, { type: 'triangle' }); },
};

export const sfx = (name) => SFX[name]?.();
