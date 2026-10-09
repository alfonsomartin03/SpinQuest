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

/**
 * Cadence-hold resistance: ride at a steady pace like on the road. The controller predicts where your cadence is
 * heading (cadence plus its rate of change a moment ahead) and reacts to that:
 *   - inside a padding zone around the middle of your range almost nothing happens, so the bike can speed up and
 *     slow down naturally;
 *   - toward either bound the push-back grows exponentially, and keeps growing past it, so you can't be pushed out
 *     of your range for long;
 *   - a slow term learns the power you are really holding. The terrain plays no part in the request: your power
 *     decides how fast you move in the virtual world, so a climb never changes the resistance;
 *   - a virtual-flywheel term resists sudden changes in cadence, and below the range resistance eases off fast.
 */
export class ResistanceControl {
  constructor(gears, ftp = 200, tune = {}) {
    this.gears = gears;
    this.ftp = ftp;
    this.tune = {
      // watts per rpm (as a fraction of FTP) for the instant term; watts per second per rpm for the slow term
      // found by simulating a rider, a flywheel and an ERG-style trainer (lag 0.8 to 2 s, late noisy cadence) and
      // minimising swings; see test/control.test.mjs
kp: 0.007, kd: 0.015, dTau: 0.31, outTau: 0.12, slewUp: 110, slewDown: 90, pad: 0.35, curve: 2, rate: 0.04, lead: 0.3, ki: 0.0012, centreDead: 1.5, firm: 1.5, firmDown: 2, maxUp: 0.06, maxDown: 0.16, ...tune,
    };
    this.bias = 0; // watts added to what the road/gear demand, at the middle cadence
    this.cadF = 0;
    this.accel = 0; // filtered rate of change of cadence (rpm per second)
    this.started = false;
    this.out = null;
  }

  /** The cadence to hold: the middle of the range. */
  get ref() { return (this.gears.low + this.gears.high) / 2; }

  /** Watts the current gear alone demands at the middle cadence. The terrain is deliberately left out: the rider's
   *  power drives the virtual world, never the other way round. */
  physics({ mass }) {
    return this.gears.targetPower({ cadence: this.ref, grade: 0, mass, drag: 1 });
  }

  /** Keep resistance continuous across an automatic gear change (the baseline moves, the feel doesn't). */
  compensate(physBefore, physAfter) {
    this.bias += physBefore - physAfter;
  }

  /** @returns {number} the target power (W) to ask the trainer for */
  update(dt, cadence, ctx) {
    const { low, high } = this.gears;
    const T = this.tune;
    if (!this.started) { this.cadF = cadence; this.started = true; }
    const prev = this.cadF;
    this.cadF += (cadence - this.cadF) * (1 - Math.exp(-dt / 0.35));
    if (dt > 0) this.accel += (clamp((this.cadF - prev) / dt, -60, 60) - this.accel) * (1 - Math.exp(-dt / T.dTau));
    const c = this.cadF;
    const mid = this.ref;
    const e = c - mid;
    const phys = this.physics(ctx);
    const half = (high - low) / 2;
    // Look ahead: where will cadence be in `lead` seconds if it keeps changing like this? Respond to that.
    const ep = e + clamp(this.accel, -40, 40) * T.lead;
    const dead = T.pad * half; // free zone around the middle: natural road acceleration and deceleration
    const u = Math.max(0, Math.abs(ep) - dead) / (half - dead); // 0 inside the padding, 1 at the bound, >1 beyond it
    const ramp = (Math.exp(T.curve * Math.min(u, 1.6)) - 1) / (Math.exp(T.curve) - 1); // exponential towards the bounds
    // Slow learning of the power the rider is really holding: drifts the base level until cadence sits near the middle.
    if (c > 25) {
      const eDead = Math.sign(e) * Math.max(0, Math.abs(e) - T.centreDead);
      let rate = this.ftp * T.ki * eDead * (Math.abs(ep) > dead ? T.firm : 1);
      if (rate < 0 && c < low) rate *= T.firmDown; // sagging below the range: ease off faster so the rider is never left grinding
      this.bias += clamp(rate, -this.ftp * T.maxDown, this.ftp * T.maxUp) * dt;
    }
    const outside = c > high || c < low;
    const level = clamp(phys + this.bias, 0.08 * this.ftp, 4 * this.ftp);
    this.bias = level - phys; // no wind-up beyond the limits
    // instant proportional term, and a fade-out below ~40 rpm so a stalling rider is never pinned
    const kp = this.ftp * T.kp;
    // exponential push-back: almost nothing in the padding zone, climbing steeply as cadence nears (and passes) a bound
    const push = Math.sign(ep) * this.ftp * T.rate * ramp;
    const fade = clamp((c - 38) / (low - 38), 0, 1);
    // virtual inertia: resist *changes* in cadence, as a heavy flywheel would, so a surge or a dip can't run away
    const inertia = this.ftp * T.kd * this.accel;
    const want = Math.max(0, level + kp * clamp(e, -40, 40) + push + inertia) * (fade * fade * (3 - 2 * fade));
    // smooth and rate-limit the request so the trainer is never jerked
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
