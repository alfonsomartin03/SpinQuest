// Virtual gears. A Zwift Cog gives the trainer one fixed gear, so cadence only feels natural if
// resistance follows a virtual gear: speed = cadence x gear ratio, and the trainer is asked for the
// power that speed needs on the current gradient (with drafting). Harder gear or steeper road means
// more watts at the same cadence, exactly like a real bike, so you shift to keep your cadence: yourself
// (Zwift Click, buttons, keys) or with auto-shift, which changes gears and nothing else.

import { powerFromSpeed, clamp } from './physics.js';

export const WHEEL_CIRCUMFERENCE = 2.096; // m (700x25c)
const CHAINRING = 50;
// 24 gears, easiest to hardest (a 50 t ring with 40 t down to 11 t cogs)
const COGS = [40, 36, 34, 32, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11];
export const GEAR_COUNT = COGS.length;
export const GEAR_RATIOS = COGS.map((c) => CHAINRING / c);

export class VirtualGears {
  constructor({ auto = true, gear = 17, low = 80, high = 100 } = {}) { // gear 17 = 50x18
    this.auto = auto;
    this.low = low; // comfortable cadence range (rpm) for auto-shifting
    this.high = high;
    this.idx = clamp(gear - 1, 0, GEAR_COUNT - 1);
    this.hi = 0; // seconds spinning too fast
    this.lo = 0; // seconds grinding too slow
    this.sinceShift = 99;
    this.holdUntil = 0;
    this.clock = 0;
  }

  get gear() { return this.idx + 1; }
  get ratio() { return GEAR_RATIOS[this.idx]; }

  /** Shift by `dir` gears (+1 harder). Manual shifts pause auto-shifting for a few seconds. */
  shift(dir, manual = true) {
    const next = clamp(this.idx + dir, 0, GEAR_COUNT - 1);
    if (next === this.idx) return false;
    this.idx = next;
    this.sinceShift = 0;
    this.hi = 0;
    this.lo = 0;
    if (manual) this.holdUntil = this.clock + 8;
    return true;
  }

  /** How far a cadence is outside the comfortable range (0 = inside). */
  #outside(c) { return c < this.low ? this.low - c : c > this.high ? c - this.high : 0; }

  /** Only shift if the cadence you'd settle at is closer to your range than now (no overshooting). */
  #helps(dir, cadence) {
    const next = this.idx + dir;
    if (next < 0 || next >= GEAR_COUNT) return false;
    if (dir > 0 && cadence > this.high + 25 && this.hi < 4) return false; // a sprint (it lasts seconds): leave the gear alone
    const after = (cadence * this.ratio) / GEAR_RATIOS[next]; // same speed, different gear
    return this.#outside(after) < this.#outside(cadence);
  }

  /**
   * Auto-shift: easier when cadence stays below the range, harder when it stays above it.
   * Hard sprints (far above the range) are left alone. Returns the shift direction or 0.
   */
  update(dt, cadence) {
    this.clock += dt;
    this.sinceShift += dt;
    if (!this.auto || this.clock < this.holdUntil) return 0;
    this.hi = cadence > this.high ? this.hi + dt : 0;
    this.lo = cadence > 5 && cadence < this.low ? this.lo + dt : 0; // (barely turning the pedals still counts as pedalling: that is the grinding case)
    // The gears are all that keeps cadence in range, so respond quickly, and faster still when well outside it
    // (on a steep climb a bad gear can take several shifts to put right).
    const far = this.#outside(cadence) > 12;
    if (this.sinceShift < (far ? 1.2 : 2.5)) return 0;
    if (this.hi > (far ? 0.8 : 1.5) && this.#helps(+1, cadence) && this.shift(+1, false)) return 1;
    if (this.lo > (far ? 1 : 2) && this.#helps(-1, cadence) && this.shift(-1, false)) return -1;
    return 0;
  }

  /** Virtual speed (m/s) at this cadence in the current gear. */
  speed(cadence) { return (cadence / 60) * this.ratio * WHEEL_CIRCUMFERENCE; }

  /** Watts the trainer should resist with right now. */
  targetPower({ cadence, grade, mass, drag = 1 }) {
    return powerFromSpeed(this.speed(cadence), grade, mass, drag);
  }
}

/**
 * Resistance for a free ride: the road's own, felt through the gear you are in. The trainer is asked for the power that
 * the speed this gear gives at your cadence would take on the gradient you are on (and in a draft), exactly as on a real
 * bike with a real cassette. There is no controller trying to hold your cadence: that is the gears' job (shifting
 * yourself, or auto-shift), and your power stays your own. So the terrain matters: a steep climb in the easiest gear can
 * still make you grind if you don't push enough watts, and a descent asks for almost nothing.
 *
 * Only two things soften it, so the trainer is never jerked or pinned: the request is smoothed and rate-limited, and it
 * fades out below ~40 rpm so a stalling rider is let go rather than locked up.
 */
export class GearResistance {
  constructor(gears, tune = {}) {
    this.gears = gears;
    this.tune = { cadTau: 0.4, outTau: 0.15, slewUp: 600, slewDown: 900, maxW: 2000, ...tune };
    this.cadF = null;
    this.out = null;
  }

  /** @returns {number} the target power (W) to ask the trainer for */
  update(dt, cadence, { grade, mass, drag = 1 }) {
    const T = this.tune;
    this.cadF = this.cadF == null ? cadence : this.cadF + (cadence - this.cadF) * (1 - Math.exp(-dt / T.cadTau));
    const c = this.cadF;
    const f = clamp((c - 20) / 20, 0, 1);
    const fade = f * f * (3 - 2 * f); // 0 at 20 rpm, 1 from 40 rpm
    const want = clamp(this.gears.targetPower({ cadence: c, grade, mass, drag }) * fade, 0, T.maxW);
    if (this.out == null) this.out = want;
    const target = this.out + (want - this.out) * (1 - Math.exp(-dt / T.outTau));
    this.out = clamp(target, this.out - T.slewDown * dt, this.out + T.slewUp * dt);
    return this.out;
  }
}

/** ERG with a guard: if the rider is grinding below their range, ease the target so the trainer can't pin them. */
export function ergGuard(watts, cadence, low) {
  if (cadence > 20 && cadence < low) return watts * clamp(cadence / low, 0.3, 1) ** 2;
  return watts;
}

/** Limit how fast the requested power may rise so a sudden cadence spike can't jerk the trainer. */
export function slew(prev, target, dt, maxRisePerSec = 300) {
  if (prev == null) return target;
  return target > prev ? Math.min(target, prev + maxRisePerSec * dt) : target;
}
