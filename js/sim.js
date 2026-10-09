// Simulated trainer + HR strap so the game is playable (and demo-able) without hardware.

import { clamp } from './physics.js';

export class Sim {
  constructor(profile) {
    this.profile = profile;
    this.offset = 0; // manual adjustment from the keyboard
    this.sprint = false;
    this.stopped = false; // simulates the rider stopping pedalling
    this.power = 0;
    this.hr = 72;
    this.phase = Math.random() * 10;
  }

  /** Advance by dt seconds. `targetWatts` is the workout target (or null for free ride). */
  update(dt, targetWatts) {
    const { ftp, maxHr } = this.profile;
    const base = targetWatts ?? 0.62 * ftp;
    const goal = this.stopped ? 0 : Math.max(0, base + this.offset + (this.sprint ? 450 : 0));
    if (this.stopped) this.power = 0;
    this.power += (goal - this.power) * (1 - Math.exp(-dt / 1.2));
    this.phase += dt;
    const wobble = 1 + 0.04 * Math.sin(this.phase * 2.3) + 0.03 * Math.sin(this.phase * 5.1);
    const p = this.power < 3 ? 0 : this.power * wobble;

    const f = clamp(p / ftp, 0, 1.3);
    const hrGoal = 72 + (0.96 * maxHr - 72) * Math.min(1, f / 1.05) ** 0.9;
    this.hr += (hrGoal - this.hr) * (1 - Math.exp(-dt / 18));

    const cadence = p === 0 ? 0 : clamp(78 + 14 * f + 3 * Math.sin(this.phase * 1.7), 55, 115);
    return { power: Math.round(p), cadence: Math.round(cadence), hr: Math.round(this.hr) };
  }
}
