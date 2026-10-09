// Run with: node --test spinquest/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, parseCyclingPower, parseHeartRate } from '../js/ble.js';
import { speedFromPower, gradeAt, elevation, LOOP, SEGMENTS, powerZone, levelFor, xpForLevel } from '../js/physics.js';
import { WORKOUTS, workoutAt, totalDuration } from '../js/workouts.js';
import { Game } from '../js/game.js';
import { posAt, headingAt, LANDMARKS, envAt } from '../js/course.js';

const view = (bytes) => new DataView(new Uint8Array(bytes).buffer);

test('FTMS indoor bike data: speed, cadence, power, hr', () => {
  // flags: cadence(bit2) + power(bit6) + hr(bit9) = 0x0244; bit0 = 0 so speed present
  const d = parseIndoorBikeData(view([0x44, 0x02, /*speed*/ 0xb8, 0x0b, /*cad*/ 0xb4, 0x00, /*power*/ 0xfa, 0x00, /*hr*/ 142]));
  assert.equal(d.speed, 30); // 3000 / 100
  assert.equal(d.cadence, 90);
  assert.equal(d.power, 250);
  assert.equal(d.hr, 142);
});

test('FTMS skips fields it does not carry', () => {
  // flags: avg speed(1) + total distance(4) + power(6) => speed, avg speed, distance(3), power
  const d = parseIndoorBikeData(view([0x52, 0x00, 1, 0, 2, 0, 3, 0, 0, 0xc8, 0x00]));
  assert.equal(d.power, 200);
  assert.equal(d.cadence, undefined);
});

test('Cycling power: power and cadence from crank revolutions', () => {
  const state = {};
  // flags 0x20 = crank data; power 200; revs 10 @ t=1024 then revs 11 @ t=1024+683 (0.667 s -> 90 rpm)
  const mk = (revs, t) => view([0x20, 0x00, 200, 0, revs & 255, revs >> 8, t & 255, t >> 8]);
  assert.equal(parseCyclingPower(mk(10, 1024), state).cadence, undefined);
  const d = parseCyclingPower(mk(11, 1024 + 683), state);
  assert.equal(d.power, 200);
  assert.ok(Math.abs(d.cadence - 90) < 0.5, `cadence ${d.cadence}`);
});

test('Cycling power: optional fields before crank data are skipped', () => {
  // flags: pedal balance(0) + accumulated torque(2) + wheel(4) + crank(5)
  const bytes = [0x35, 0x00, 150, 0, 50, 1, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 4];
  const state = {};
  parseCyclingPower(view(bytes), state);
  assert.equal(state.revs, 5);
  assert.equal(state.time, 1024);
});

test('Heart rate: 8-bit and 16-bit formats', () => {
  assert.equal(parseHeartRate(view([0x00, 150])).hr, 150);
  assert.equal(parseHeartRate(view([0x01, 0x2c, 0x01])).hr, 300);
});

test('physics: sensible speeds', () => {
  const flat = speedFromPower(200, 0, 84) * 3.6;
  assert.ok(flat > 28 && flat < 36, `flat ${flat}`);
  const climb = speedFromPower(200, 0.08, 84) * 3.6;
  assert.ok(climb > 8 && climb < 13, `climb ${climb}`);
  assert.ok(speedFromPower(0, -0.06, 84) > 8); // free-wheeling downhill
  assert.equal(speedFromPower(0, 0, 84), 0);
  assert.ok(speedFromPower(200, 0, 84, 0.7) > speedFromPower(200, 0, 84)); // drafting helps
});

test('course loops seamlessly and has sane gradients', () => {
  assert.ok(Math.abs(elevation(0) - elevation(LOOP)) < 1e-9);
  for (let d = 0; d < LOOP; d += 25) assert.ok(Math.abs(gradeAt(d)) < 0.105, `grade ${gradeAt(d)} at ${d}`);
  assert.equal(SEGMENTS.length, 4);
  for (const s of SEGMENTS) assert.ok(s.start >= 0 && s.end <= LOOP);
});

test('course geometry closes on itself and has landmarks in zones', () => {
  const a = posAt(0), b = posAt(LOOP - 5);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 8);
  assert.ok(Math.abs(headingAt(LOOP) - headingAt(0)) > 6); // one full turn per lap
  for (const lm of LANDMARKS) assert.ok(lm.d >= 0 && lm.d < LOOP);
  assert.ok(envAt(7500).water > 0.9 && envAt(1000).water === 0);
  assert.ok(envAt(4600).snow > 0.5 && envAt(500).snow === 0);
});

test('zones and levels', () => {
  assert.equal(powerZone(100, 200), 0);
  assert.equal(powerZone(200, 200), 3);
  assert.equal(powerZone(600, 200), 6);
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(xpForLevel(5)), 5);
});

test('workouts have positive durations and resolve targets', () => {
  for (const w of WORKOUTS) {
    for (const s of w.steps) assert.ok(s.dur > 0);
    if (!w.steps.length) continue;
    assert.ok(workoutAt(w, 1, 200).watts > 0);
    assert.ok(workoutAt(w, totalDuration(w) + 5, 200).done);
  }
});

test('game: simulated 90 s ride scores, moves and unlocks First Spin', () => {
  const progress = { xp: 0, ach: {}, segPR: {} };
  const g = new Game({ profile: { name: 'T', weight: 75, ftp: 200, maxHr: 190 }, workout: WORKOUTS[0], progress });
  for (let i = 0; i < 90 * 20; i++) g.update(0.05, { power: 150, cadence: 85, hr: 130 });
  assert.ok(g.started && !g.paused);
  assert.ok(g.distance > 500, `distance ${g.distance}`);
  assert.ok(g.score > 50);
  assert.ok(g.unlocked.includes('first-spin'));
  assert.ok(g.hz >= 0);
});

test('game: workout target tracking builds a combo and auto-pauses on silence', () => {
  const progress = { xp: 0, ach: {}, segPR: {} };
  const w = WORKOUTS.find((x) => x.id === 'quick');
  const g = new Game({ profile: { name: 'T', weight: 75, ftp: 200, maxHr: 190 }, workout: w, progress });
  for (let i = 0; i < 40 * 20; i++) g.update(0.05, { power: 105, cadence: 85, hr: 120 }); // warm-up target 100-120 W
  assert.ok(g.target, 'target defined');
  assert.ok(g.coach, 'coach present');
  const tClock = g.t;
  for (let i = 0; i < 8 * 20; i++) g.update(0.05, { power: 0, cadence: 0, hr: 100 });
  assert.ok(g.paused);
  assert.ok(g.t - tClock < 6, 'timers stop while paused');
});
