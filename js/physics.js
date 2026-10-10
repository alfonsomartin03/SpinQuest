// Rider physics, the looping course, and training zones.

const G = 9.81;

// ---- Speed from power ---------------------------------------------------------------------------------
// Steady-state cycling physics: power at the wheel (after drivetrain loss) = air drag + rolling resistance + gravity.
//   P * 0.975 = 0.5 * rho * CdA * v^3 + m * g * (Crr * cos(t) + sin(t)) * v
// What the rider looks like to the wind depends on who they are and what they are doing:
//  - Bigger riders are bigger in the wind, but not in proportion to their weight (CdA grows about with mass^0.4, so
//    weight still wins downhill: terminal speed grows with about mass^0.3). A 100 kg rider coasts clearly faster down the
//    same hill than a 55 kg one, and climbs slower per watt.
//  - On a descent everyone tucks: the frontal area shrinks by up to 18% as the road drops from 2% to 6%.
// There is no artificial speed limit; the only bound is a very high solver ceiling (160 km/h), so a heavy rider on a
// steep enough descent can pass 80 km/h while a light one cannot.

const RHO = 1.2; // air density (kg/m^3)
const CDA_REF = 0.32; // m^2, for a 84 kg rider-plus-bike
const MASS_REF = 84;
const CDA_MASS_EXP = 0.4;
const CRR = 0.004;
const DRIVETRAIN = 0.975;
export const V_MAX = 45; // m/s (162 km/h)

const smoothstep01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

/** Aerodynamic drag coefficient term 0.5 * rho * CdA for this rider on this road. `drag` is < 1 when drafting. */
export function dragTerm(grade, mass, drag = 1) {
  const size = (mass / MASS_REF) ** CDA_MASS_EXP;
  const tuck = 1 - 0.18 * smoothstep01((-grade - 0.02) / 0.04);
  return 0.5 * RHO * CDA_REF * size * tuck * drag;
}

/** Steady-state speed (m/s) for a given power, gradient (rise/run) and total mass (kg).
 *  `drag` scales aerodynamic drag (<1 when drafting). */
export function speedFromPower(power, grade, mass, drag = 1) {
  const theta = Math.atan(grade);
  const a = dragTerm(grade, mass, drag);
  const b = mass * G * (CRR * Math.cos(theta) + Math.sin(theta));
  const c = Math.max(0, power) * DRIVETRAIN;
  let lo = 0;
  let hi = V_MAX * 1.5;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    if (a * v * v * v + b * v - c > 0) hi = v;
    else lo = v;
  }
  return Math.min(lo, V_MAX);
}

/** Power (W) needed to hold speed `v` (m/s): the inverse of speedFromPower. */
export function powerFromSpeed(v, grade, mass, drag = 1) {
  const theta = Math.atan(grade);
  const a = dragTerm(grade, mass, drag);
  const b = mass * G * (CRR * Math.cos(theta) + Math.sin(theta));
  return Math.max(0, (a * v * v * v + b * v) / DRIVETRAIN);
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
/** Default zone ceilings in bpm (zones 1 to 4) for a max HR. */
export const defaultHrLimits = (maxHr) => HR_ZONES.slice(0, -1).map((z) => Math.round(z.max * maxHr));
/** Make custom ceilings usable: four ascending whole numbers, or null (use % of max HR). */
export const cleanHrLimits = (limits) => {
  if (!Array.isArray(limits) || limits.length !== HR_ZONES.length - 1) return null;
  const out = limits.map(Math.round);
  return out.every((v, i) => Number.isFinite(v) && v > 0 && (i === 0 || v > out[i - 1])) ? out : null;
};
/** Zone index for a heart rate. `limits` are optional custom bpm ceilings for zones 1 to 4. */
export const hrZone = (hr, maxHr, limits = null) => {
  const l = cleanHrLimits(limits);
  return l ? zoneIndex(l.map((v) => ({ max: v })).concat({ max: Infinity }), hr) : zoneIndex(HR_ZONES, hr / maxHr);
};

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
