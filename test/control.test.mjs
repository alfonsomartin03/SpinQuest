// Cadence-hold resistance control. The closed-loop tests simulate a rider (a chosen power, with wobble), a flywheel
// and an ERG-style trainer that takes a second or more to change resistance and reads cadence late and noisily,
// across light and heavy flywheels and slow and fast trainers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualGears, ResistanceControl, ergGuard } from '../js/gearing.js';

const LOW = 80, HIGH = 100, MID = 90;

function simulate({ mode = 'new', effort, disturb = null, secs = 90, J = 5, lag = 1, delay = 0.3, noise = 1, wobble = 12, seed = 5 }) {
  const gears = new VirtualGears({ auto: false, low: LOW, high: HIGH });
  const ctl = new ResistanceControl(gears, 250);
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const gauss = () => rnd() + rnd() + rnd() - 1.5;
  let w = (MID * Math.PI) / 30, applied = 150, sent = 150, nextSend = 0, nextRead = 0, meas = MID, wob = 0;
  const dt = 0.02, hist = [], rows = [];
  for (let t = 0; t < secs; t += dt) {
    wob += (-wob / 1.5) * dt + gauss() * wobble * 0.5 * Math.sqrt(dt / 0.3); // the rider's power is never perfectly steady
    if (disturb && Math.abs(t - disturb.t) < dt / 2) w = (disturb.rpm * Math.PI) / 30;
    const rpm = (w * 30) / Math.PI;
    hist.push(rpm);
    if (t >= nextRead) { nextRead += 0.25; meas = Math.round(hist[Math.max(0, hist.length - 1 - Math.round(delay / dt))] + gauss() * noise); }
    const ctx = { grade: 0, mass: 84, drag: 1 };
    const cmd = mode === 'new' ? ctl.update(dt, meas, ctx) : gears.targetPower({ cadence: meas, ...ctx }); // 'old' = the first power-for-cadence target
    if (t >= nextSend) { nextSend += 0.25; sent = Math.min(2000, cmd); }
    applied += (sent - applied) * (1 - Math.exp(-dt / lag)); // the trainer holds power, with lag
    const wr = Math.max(w, 3);
    w = Math.max(0, w + (((Math.max(0, effort(t) + wob) - applied) / wr - 0.02 * w) / J) * dt);
    rows.push({ t, rpm: (w * 30) / Math.PI, power: applied });
  }
  return rows;
}

const PLANTS = [[3, 0.8, 0.3], [5, 1.0, 0.3], [8, 1.5, 0.4], [5, 2.0, 0.5], [4, 1.2, 0.6]]; // [inertia, trainer lag (s), cadence delay (s)]
const after = (rows, t0) => rows.filter((r) => r.t >= t0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const late = (rows) => after(rows, rows.at(-1).t - 15);
const ramp = (from, to, t0 = 25, dur = 4) => (t) => { const k = Math.min(1, Math.max(0, (t - t0) / dur)); return from + (to - from) * k * k * (3 - 2 * k); };
const maxRate = (rows) => { let m = 0; for (let i = 1; i < rows.length; i++) m = Math.max(m, Math.abs(rows[i].power - rows[i - 1].power) / (rows[i].t - rows[i - 1].t)); return m; };

test('steady riding holds the middle of the range with almost no movement in the request', () => {
  for (const [J, lag, delay] of PLANTS) {
    const l = late(simulate({ effort: () => 200, J, lag, delay }));
    assert.ok(Math.abs(mean(l.map((r) => r.rpm)) - MID) < 5, `${mean(l.map((r) => r.rpm)).toFixed(0)} rpm is not the middle of the range`);
    assert.ok(sd(l.map((r) => r.rpm)) < 4, `cadence wobble ${sd(l.map((r) => r.rpm)).toFixed(1)} rpm`);
    assert.ok(sd(l.map((r) => r.power)) < 14, `the request wanders by ${sd(l.map((r) => r.power)).toFixed(1)} W`);
  }
});

test('changes in effort re-centre cadence smoothly, with no repeating swings (the reported 130 <-> 320 W cycle)', () => {
  for (const [J, lag, delay] of PLANTS) {
    for (const [from, to] of [[200, 320], [200, 120], [140, 260], [120, 320]]) {
      const rows = simulate({ effort: ramp(from, to), J, lag, delay });
      const l = late(rows);
      const swing = Math.max(...l.map((r) => r.power)) - Math.min(...l.map((r) => r.power));
      assert.ok(Math.abs(mean(l.map((r) => r.rpm)) - MID) < 6, `${from}>${to}: cadence ended at ${mean(l.map((r) => r.rpm)).toFixed(0)}`);
      assert.ok(Math.abs(mean(l.map((r) => r.power)) - to) < 14, `${from}>${to}: power ended at ${mean(l.map((r) => r.power)).toFixed(0)} W`);
      assert.ok(swing < (lag >= 2 && to - from >= 200 ? 100 : 70), // a 200 W jump on a 2 s-lag trainer takes longer to settle
         `${from}>${to}: still swinging by ${swing.toFixed(0)} W (J${J} lag${lag})`);
      assert.ok(maxRate(after(rows, 25)) < 130, `the request moves too abruptly: ${maxRate(after(rows, 25)).toFixed(0)} W/s`);
    }
  }
});

test('a stumble in cadence recovers instead of spiralling', () => {
  for (const [J, lag, delay] of PLANTS) {
    for (const rpm of [50, 62]) {
      const rows = simulate({ effort: () => 200, disturb: { t: 25, rpm }, J, lag, delay });
      assert.ok(Math.min(...after(rows, 25.5).map((r) => r.rpm)) >= rpm - 6, `fell to ${Math.min(...after(rows, 25.5).map((r) => r.rpm)).toFixed(0)} after a stumble to ${rpm}`);
      assert.ok(Math.abs(mean(late(rows).map((r) => r.rpm)) - MID) < 6, 'recovered to the middle');
    }
  }
});

test('the first power-for-cadence target let cadence settle low (grinding); the cadence-hold keeps it centred', () => {
  const eff = ramp(200, 110);
  const old = mean(late(simulate({ mode: 'old', effort: eff })).map((r) => r.rpm));
  const now = mean(late(simulate({ effort: eff })).map((r) => r.rpm));
  assert.ok(old < LOW - 1, `old behaviour settled at ${old.toFixed(0)} rpm`);
  assert.ok(Math.abs(now - MID) < 5, `new behaviour settled at ${now.toFixed(0)} rpm`);
});

test('controller rules: dead zone at the middle, firmer outside the range, virtual inertia on fast changes', () => {
  const mk = () => new ResistanceControl(new VirtualGears({ auto: false, low: LOW, high: HIGH }), 250);
  const ctx = { grade: 0, mass: 84, drag: 1 };
  const run = (ctl, rpm, secs) => { for (let i = 0; i < secs * 50; i++) ctl.update(0.02, rpm, ctx); return ctl.bias; };

  assert.ok(Math.abs(run(mk(), MID, 20)) < 1e-6, 'at the middle nothing changes');
  assert.ok(Math.abs(run(mk(), MID + 1, 20)) < 1e-6, 'inside the dead zone nothing changes');
  const up = run(mk(), 96, 10), down = run(mk(), 84, 10);
  assert.ok(up > 5 && down < -5, `above the middle resistance firms up (${up.toFixed(0)}), below it eases (${down.toFixed(0)})`);
  assert.ok(run(mk(), 108, 5) > run(mk(), 98, 5) * 1.5, 'the further from the middle (and outside the range), the firmer');
  assert.ok(Math.abs(run(mk(), 10, 10)) < 1e-6, 'nothing adapts while not really pedalling');
  assert.ok(mk().update(0.02, 0, ctx) < 1, 'no cadence, no resistance');
  assert.ok(Number.isFinite(run(mk(), 300, 5)), 'finite for absurd cadences');

  // a cadence that is climbing quickly gets more resistance than one holding still (virtual inertia)
  const steady = mk(), rising = mk();
  let a = 0, b = 0;
  for (let i = 0; i < 100; i++) { a = steady.update(0.02, 90, ctx); b = rising.update(0.02, 90 + i * 0.1, ctx); }
  assert.ok(b > a, 'faster cadence, more resistance');
});

test('automatic shifts keep resistance continuous; the request is never negative or wild', () => {
  const g = new VirtualGears({ auto: false, low: LOW, high: HIGH });
  const ctl = new ResistanceControl(g, 250);
  const ctx = { grade: 0.03, mass: 84, drag: 1 };
  for (let i = 0; i < 200; i++) ctl.update(0.02, MID, ctx);
  const before = ctl.update(0.02, MID, ctx);
  const physBefore = ctl.physics(ctx);
  g.shift(+1, false);
  ctl.compensate(physBefore, ctl.physics(ctx));
  for (let i = 0; i < 100; i++) ctl.update(0.02, MID, ctx);
  const afterShift = ctl.update(0.02, MID, ctx);
  assert.ok(Math.abs(afterShift - before) < 12, `${before.toFixed(0)} -> ${afterShift.toFixed(0)} W`);
  for (let rpm = 0; rpm <= 250; rpm += 5) { const p = new ResistanceControl(g, 250).update(0.02, rpm, ctx); assert.ok(p >= 0 && p <= 2200, `${rpm} rpm -> ${p}`); }
});

test('ERG guard eases the target when grinding below the range only', () => {
  assert.equal(ergGuard(250, 90, LOW), 250);
  assert.equal(ergGuard(250, LOW, LOW), 250);
  assert.ok(ergGuard(250, 60, LOW) < 150 && ergGuard(250, 60, LOW) > 100);
  assert.ok(ergGuard(250, 30, LOW) < 60);
  assert.equal(ergGuard(250, 0, LOW), 250, 'not pedalling: leave it to the pause logic');
});

test('terrain never changes the resistance request', () => {
  const run = (grade) => { const c = new ResistanceControl(new VirtualGears({ auto: false, low: LOW, high: HIGH }), 250); let p = 0; for (let i = 0; i < 500; i++) p = c.update(0.02, MID, { grade, mass: 84, drag: 0.6 }); return p; };
  assert.equal(run(0), run(0.12));
  assert.equal(run(0), run(-0.08));
});
