// Free-ride resistance and auto-shift. Resistance is the road's own through the current gear (GearResistance); auto-shift
// only ever changes the gear. The closed-loop tests ride a rider at a steady power: cadence settles where the gear's
// resistance equals that power, exactly as it would on a real bike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualGears, GearResistance, ergGuard, GEAR_RATIOS } from '../js/gearing.js';

const LOW = 80, HIGH = 100;
const CTX = { grade: 0, mass: 84, drag: 1 };

/** The cadence at which this gear on this road asks for `power` (the resistance rises with cadence, so bisect). */
function cadenceFor(gears, power, ctx) {
  let lo = 0, hi = 220;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (gears.targetPower({ cadence: mid, ...ctx }) > power) hi = mid; else lo = mid; }
  return lo;
}

/** Ride at a steady `power` on a constant grade; returns what cadence, gear and request did. */
function ride({ power, grade = 0, auto = true, secs = 120, gear = 17, low = LOW, high = HIGH }) {
  const gears = new VirtualGears({ auto, gear, low, high });
  const res = new GearResistance(gears);
  const ctx = { grade, mass: 84, drag: 1 };
  let cad = cadenceFor(gears, power, ctx), shifts = 0;
  const rows = [];
  const dt = 0.1;
  for (let t = 0; t < secs; t += dt) {
    cad += (cadenceFor(gears, power, ctx) - cad) * (1 - Math.exp(-dt / 1.2)); // the legs follow the gear with a little lag
    if (gears.update(dt, cad)) shifts++;
    const want = res.update(dt, cad, ctx);
    rows.push({ t, cad, gear: gears.gear, want });
  }
  return { rows, shifts, gears, last: rows.at(-1) };
}

test('resistance is the road demand through the gear: more watts for a harder gear or a steeper road, almost none downhill', () => {
  const at = (gear, grade) => {
    const g = new VirtualGears({ auto: false, gear }); const r = new GearResistance(g);
    let p = 0; for (let i = 0; i < 100; i++) p = r.update(0.05, 90, { grade, mass: 84, drag: 1 });
    return { p, expect: g.targetPower({ cadence: 90, grade, mass: 84 }) };
  };
  const flat = at(17, 0);
  assert.ok(Math.abs(flat.p - flat.expect) < 2, `${flat.p.toFixed(0)} W vs ${flat.expect.toFixed(0)} W`);
  assert.ok(at(19, 0).p > flat.p, 'a harder gear asks for more');
  assert.ok(at(17, 0.06).p > flat.p * 1.8, 'a climb asks for much more at the same gear and cadence');
  assert.ok(at(17, -0.05).p < 40, 'a descent asks for almost nothing');
  assert.ok(at(17, 0.12).p > at(17, 0.06).p, 'and the steeper the more');
});

test('the request is smooth, never negative, never wild, and lets go of a stalling rider', () => {
  const g = new VirtualGears({ auto: false });
  const r = new GearResistance(g);
  let prev = null, worst = 0;
  for (let i = 0; i < 400; i++) {
    const p = r.update(0.05, i < 200 ? 90 : 150, { grade: 0.04, mass: 84, drag: 1 });
    if (prev != null) worst = Math.max(worst, Math.abs(p - prev) / 0.05);
    prev = p;
    assert.ok(p >= 0 && p <= 2000);
  }
  assert.ok(worst <= 900 + 1e-6, `the request moved at ${worst.toFixed(0)} W/s`);
  const stall = new GearResistance(g);
  for (let i = 0; i < 100; i++) stall.update(0.05, 30, { grade: 0.1, mass: 84, drag: 1 });
  assert.ok(stall.out < new GearResistance(g).update(0.05, 90, { grade: 0.1, mass: 84, drag: 1 }) * 0.6, 'below ~40 rpm it eases off');
  assert.equal(new GearResistance(g).update(0.05, 0, CTX), 0, 'no cadence, no resistance');
  assert.ok(Number.isFinite(new GearResistance(g).update(0.05, 400, CTX)), 'finite for absurd cadences');
});

test('auto-shift finds a gear that puts cadence in the range and then leaves it alone', () => {
  for (const [power, grade] of [[200, 0], [150, 0], [250, 0.03], [220, 0.05], [300, -0.02]]) {
    for (const gear of [11, 17, 22]) {
      const { last, rows, shifts } = ride({ power, grade, gear });
      assert.ok(last.cad >= LOW - 1.5 && last.cad <= HIGH + 1.5, `${power} W on ${grade * 100}% from gear ${gear}: ended at ${last.cad.toFixed(0)} rpm in gear ${last.gear}`);
      const late = rows.filter((r) => r.t > 90);
      assert.ok(new Set(late.map((r) => r.gear)).size === 1, 'no hunting between gears once it has settled');
      assert.ok(shifts <= 24, `${shifts} shifts`);
    }
  }
});

test('terrain matters: on a climb steep enough, a rider without the watts is left grinding below the range, in the easiest gear', () => {
  const grind = ride({ power: 130, grade: 0.12 });
  assert.equal(grind.last.gear, 1, 'it ran out of gears');
  assert.ok(grind.last.cad < LOW - 5, `cadence ${grind.last.cad.toFixed(0)} rpm: grinding`);
  const ok = ride({ power: 180, grade: 0.04 });
  assert.ok(ok.last.cad >= LOW - 1.5, `${ok.last.cad.toFixed(0)} rpm: decent watts on an easier road are fine`);
  // more watts on the same climb gets the cadence back
  assert.ok(ride({ power: 330, grade: 0.12 }).last.cad > grind.last.cad + 15);
});

test('shifting yourself: nothing is shifted for you, even far outside your range', () => {
  for (const gear of [3, 17, 24]) {
    const r = ride({ power: 140, grade: 0.09, auto: false, gear });
    assert.equal(r.shifts, 0);
    assert.equal(r.last.gear, gear);
  }
  const g = new VirtualGears({ auto: false });
  for (let i = 0; i < 300; i++) assert.equal(g.update(0.1, i < 150 ? 40 : 130), 0);
  assert.equal(g.gear, 17);
  // and manual shifts do work
  assert.ok(g.shift(-1) && g.gear === 16 && g.shift(+1, true) && g.gear === 17);
});

test('auto-shift responds faster when well outside the range, and a custom range is respected', () => {
  const far = new VirtualGears({ auto: true });
  let t = 0; while (!far.update(0.1, 55) && t < 10) t += 0.1;
  assert.ok(t <= 1.5, `shifted easier after ${t.toFixed(1)} s from 55 rpm`);
  const near = new VirtualGears({ auto: true });
  t = 0; while (!near.update(0.1, 77) && t < 10) t += 0.1;
  assert.ok(t >= 1.9 && t <= 3, `shifted easier after ${t.toFixed(1)} s from 77 rpm`);
  const narrow = ride({ power: 200, grade: 0, low: 90, high: 100 });
  assert.ok(narrow.last.cad >= 88.5 && narrow.last.cad <= 101.5, `${narrow.last.cad.toFixed(0)} rpm in a 90-100 range`);
  assert.ok(GEAR_RATIOS.length === 24);
});

test('ERG guard eases the target when grinding below the range only', () => {
  assert.equal(ergGuard(250, 90, LOW), 250);
  assert.equal(ergGuard(250, LOW, LOW), 250);
  assert.ok(ergGuard(250, 60, LOW) < 150 && ergGuard(250, 60, LOW) > 100);
  assert.ok(ergGuard(250, 30, LOW) < 60);
  assert.equal(ergGuard(250, 0, LOW), 250, 'not pedalling: leave it to the pause logic');
});
