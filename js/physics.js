// Rider physics, the looping course, and training zones.

const G = 9.81;

/** Steady-state speed (m/s) for a given power, gradient (rise/run) and total mass (kg).
 *  `drag` scales aerodynamic drag (<1 when drafting). */
export function speedFromPower(power, grade, mass, drag = 1) {
  const theta = Math.atan(grade);
  const a = 0.5 * 1.2 * 0.32 * drag;
  const b = mass * G * (0.004 * Math.cos(theta) + Math.sin(theta));
  const c = Math.max(0, power) * 0.975;
  let lo = 0;
  let hi = 30;
  for (let i = 0; i < 36; i++) {
    const v = (lo + hi) / 2;
    if (a * v * v * v + b * v - c > 0) hi = v;
    else lo = v;
  }
  return Math.min(lo, 22);
}

// ---- Course: a seamless loop of rolling hills ------------------------------

export const LOOP = 9000; // metres

const TAU = Math.PI * 2;
const phase = (d) => (((d % LOOP) + LOOP) % LOOP) / LOOP * TAU;

export function elevation(d) {
  const x = phase(d);
  return 45 * Math.sin(x) + 18 * Math.sin(3 * x + 1) + 5 * Math.sin(7 * x + 2);
}

export function gradeAt(d) {
  const x = phase(d);
  return (45 * Math.cos(x) + 54 * Math.cos(3 * x + 1) + 35 * Math.cos(7 * x + 2)) * (TAU / LOOP);
}

/** A gentle spot on the loop to start from. */
export const START = (() => {
  for (let d = 0; d < LOOP; d += 10) {
    if (Math.abs(gradeAt(d)) < 0.006 && gradeAt(d + 200) > 0) return d;
  }
  return 0;
})();

function pickSegments() {
  const gain = (s, len) => elevation(s + len) - elevation(s);
  const taken = [];
  const free = (s, len) => taken.every(([a, b]) => s + len < a - 150 || s > b + 150);
  const choose = (len, score) => {
    let best = null;
    for (let s = 0; s + len < LOOP; s += 25) {
      if (!free(s, len)) continue;
      const sc = score(s, len);
      if (!best || sc > best.sc) best = { s, sc };
    }
    taken.push([best.s, best.s + len]);
    return best.s;
  };
  const climbS = choose(1200, (s, l) => gain(s, l));
  const sprintS = choose(250, (s, l) => -Math.abs(gain(s, l)) - Math.abs(gradeAt(s)) * 50);
  const dashS = choose(300, (s, l) => -gain(s, l));
  return [
    { id: 'kom', name: 'Hilltop KOM', kind: 'climb', start: climbS, end: climbS + 1200, color: '#ff4d4d' },
    { id: 'sprint', name: 'Flat-Out Sprint', kind: 'sprint', start: sprintS, end: sprintS + 250, color: '#3ecf6e' },
    { id: 'dash', name: 'Downhill Dash', kind: 'sprint', start: dashS, end: dashS + 300, color: '#c25cff' },
  ];
}
export const SEGMENTS = pickSegments();

// ---- Zones ------------------------------------------------------------------

export const POWER_ZONES = [
  { name: 'Recovery', max: 0.55, color: '#8da2b8' },
  { name: 'Endurance', max: 0.75, color: '#3fa9f5' },
  { name: 'Tempo', max: 0.9, color: '#3ecf6e' },
  { name: 'Threshold', max: 1.05, color: '#f5c542' },
  { name: 'VO2 Max', max: 1.2, color: '#ff8a3d' },
  { name: 'Anaerobic', max: 1.5, color: '#ff4d4d' },
  { name: 'Sprint', max: Infinity, color: '#c25cff' },
];

export const HR_ZONES = [
  { name: 'Easy', max: 0.6, color: '#6aa7ff' },
  { name: 'Aerobic', max: 0.7, color: '#3ecf6e' },
  { name: 'Tempo', max: 0.8, color: '#f5c542' },
  { name: 'Threshold', max: 0.9, color: '#ff8a3d' },
  { name: 'Max', max: Infinity, color: '#ff4d4d' },
];

const zoneIndex = (zones, frac) => {
  const i = zones.findIndex((z) => frac < z.max);
  return i < 0 ? zones.length - 1 : i;
};
export const powerZone = (watts, ftp) => zoneIndex(POWER_ZONES, watts / ftp);
export const hrZone = (hr, maxHr) => zoneIndex(HR_ZONES, hr / maxHr);

// ---- Levels -----------------------------------------------------------------

export const xpForLevel = (level) => Math.round(1000 * (level - 1) ** 1.5);
export const levelFor = (xp) => 1 + Math.floor(Math.max(0, xp / 1000) ** (2 / 3) + 1e-9);

export const LEVEL_TITLES = [
  'Couch Cruiser', 'Spin Rookie', 'Pedal Pusher', 'Cadence Cadet', 'Wattage Warrior',
  'Climb Hunter', 'Sprint Specialist', 'Domestique', 'Breakaway Artist', 'Peloton Captain',
  'Grand Tour Legend',
];
export const levelTitle = (level) => LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)];

// ---- Misc ---------------------------------------------------------------------

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}
