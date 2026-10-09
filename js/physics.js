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

/** Power (W) needed to hold speed `v` (m/s): the inverse of speedFromPower. */
export function powerFromSpeed(v, grade, mass, drag = 1) {
  const theta = Math.atan(grade);
  const a = 0.5 * 1.2 * 0.32 * drag;
  const b = mass * G * (0.004 * Math.cos(theta) + Math.sin(theta));
  return Math.max(0, (a * v * v * v + b * v) / 0.975);
}

// ---- Course (see course.js) ----------------------------------------------------

export { LOOP, elevation, gradeAt, START, SEGMENTS } from './course.js';

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
