// Virtual gears. A Zwift Cog gives the trainer one fixed gear, so cadence only feels natural if
// resistance follows a virtual gear: speed = cadence x gear ratio, and the trainer is asked for the
// power that speed needs on the current gradient (with drafting). Harder gear or steeper road means
// more watts at the same cadence, exactly like a real bike, so you shift to keep your cadence.

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
    if (dir > 0 && cadence > this.high + 25) return false; // an all-out sprint: leave the gear alone
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
    this.lo = cadence > 25 && cadence < this.low ? this.lo + dt : 0;
    if (this.sinceShift < 3) return 0;
    if (this.hi > 2 && this.#helps(+1, cadence) && this.shift(+1, false)) return 1;
    if (this.lo > 3 && this.#helps(-1, cadence) && this.shift(-1, false)) return -1;
    return 0;
  }

  /** Virtual speed (m/s) at this cadence in the current gear. */
  speed(cadence) { return (cadence / 60) * this.ratio * WHEEL_CIRCUMFERENCE; }

  /** Watts the trainer should resist with right now. */
  targetPower({ cadence, grade, mass, drag = 1 }) {
    return powerFromSpeed(this.speed(cadence), grade, mass, drag);
  }
}

/** Limit how fast the requested power may rise so a sudden cadence spike can't jerk the trainer. */
export function slew(prev, target, dt, maxRisePerSec = 300) {
  if (prev == null) return target;
  return target > prev ? Math.min(target, prev + maxRisePerSec * dt) : target;
}
