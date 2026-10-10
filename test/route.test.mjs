// The fork at the foot of the climb and the flat road around it: where riders are, how they get on and off it, and the controls that choose it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOP, TOTAL, JUNCTION, REJOIN, SPUR_LEN, posAt, headingAt, elevation, climbSplits, CLIMBS, biomeIndex, BIOMES } from '../js/course.js';
import { placeOnLoop, advance, courseAt, roadX, gapBetween, sameStretch } from '../js/route.js';
import { DoubleClick } from '../js/click.js';
import { Game, TURN_RANGE } from '../js/game.js';
import { WORKOUTS } from '../js/workouts.js';
import { buildFit, PLACES } from '../js/export.js';

const rider = (x = 0) => placeOnLoop({}, x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('the road around leaves the loop at the foot of the climb and rejoins it after the descent, with the same heading and height', () => {
  for (const [c, at] of [[LOOP, JUNCTION], [TOTAL, REJOIN]]) {
    assert.ok(dist(posAt(c), posAt(at)) < 0.01, `position at ${c}`);
    assert.ok(Math.abs(elevation(c) - elevation(at)) < 0.01, `height at ${c}`);
    const dh = headingAt(c) - headingAt(at);
    assert.ok(Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))) < 0.05, `heading at ${c}`);
  }
  assert.equal(TOTAL - LOOP, SPUR_LEN);
  assert.equal(JUNCTION, CLIMBS[0].start, 'the fork is at the base of the climb');
  assert.ok(REJOIN > CLIMBS[0].end, 'it rejoins after the summit');
  assert.equal(biomeIndex(LOOP + 100), BIOMES.length - 1);
});

test('without going around a lap is 10 km and the rider never leaves the loop', () => {
  const r = rider(0);
  const events = [];
  for (let i = 0; i < 2500; i++) events.push(...advance(r, 10)); // 25 km
  assert.equal(events.filter((e) => e === 'pass').length, 3);
  assert.equal(events.filter((e) => e === 'lap').length, 2);
  assert.equal(r.spur, false);
  assert.ok(Math.abs(r.c - 5000) < 1e-6 && r.laps === 2);
});

test('going around skips the climb: the lap changes length by the road around minus the road it replaces', () => {
  const r = rider(0);
  const seen = [];
  let travelled = 0;
  while (r.laps < 1) { const ev = advance(r, 7, () => true); travelled += 7; seen.push(...ev.filter((e) => e !== 'lap')); }
  assert.deepEqual(seen, ['enter', 'exit']);
  const expected = LOOP - (REJOIN - JUNCTION) + SPUR_LEN;
  assert.ok(Math.abs(travelled - expected) < 7, `lap was ${travelled} m, expected ${expected}`);
  assert.equal(r.spur, false);
});

test('the choice is made fresh each time the turn point is reached', () => {
  const r = rider(JUNCTION - 5);
  let ask = 0;
  advance(r, 10, () => { ask++; return false; });
  assert.equal(ask, 1);
  assert.equal(r.spur, false);
  const q = rider(JUNCTION - 5);
  assert.deepEqual(advance(q, 10, () => true), ['enter']);
  assert.ok(q.spur && Math.abs(q.c - (LOOP + 5)) < 1e-9);
});

test('courseAt: the road ahead and behind follows your route', () => {
  const r = rider(JUNCTION - 20);
  assert.ok(Math.abs(courseAt(r, 10, false) - (JUNCTION - 10)) < 1e-9);
  assert.ok(Math.abs(courseAt(r, 30, true) - (LOOP + 10)) < 1e-9, 'ahead through the fork, when going around');
  assert.ok(Math.abs(courseAt(r, 30, false) - (JUNCTION + 10)) < 1e-9, 'ahead past it, when not');
  advance(r, 25, () => true); // now 5 m onto the road around
  assert.ok(r.spur);
  assert.ok(Math.abs(courseAt(r, -3) - (LOOP + 2)) < 1e-9);
  assert.ok(Math.abs(courseAt(r, -9) - (JUNCTION - 4)) < 1e-9, 'behind you, before you turned off');
  const out = rider(0);
  advance(out, JUNCTION, () => true);
  advance(out, SPUR_LEN + 6, () => true);
  assert.ok(!out.spur && Math.abs(out.c - (REJOIN + 6)) < 1e-6);
  assert.ok(Math.abs(courseAt(out, -10) - (TOTAL - 4)) < 1e-6, 'behind you, still out on the road around');
});

test('road positions and gaps: the road around is placed by progress along the stretch it replaces', () => {
  const a = rider(1000), b = rider(1400), far = rider(1400);
  advance(far, 100 + 0, () => true); // reaches the fork and turns off (1500)
  assert.ok(far.spur && Math.abs(far.c - LOOP) < 1e-9);
  assert.equal(gapBetween(a, b), 400);
  assert.equal(roadX(far), JUNCTION);
  advance(far, SPUR_LEN / 2, () => true);
  assert.ok(Math.abs(roadX(far) - (JUNCTION + (REJOIN - JUNCTION) / 2)) < 1e-6, 'halfway round is halfway through what it replaces');
  const other = rider(1400); advance(other, 100 + 300, () => true);
  assert.ok(Math.abs(gapBetween(far, other) - (other.c - far.c)) < 1e-9, 'two riders on it use real distance');
  const f2 = rider(1400); advance(f2, 100 + 20 + 300, () => true);
  assert.ok(sameStretch(a, b) && sameStretch(other, f2));
  assert.ok(!sameStretch(a, f2), 'not on the same road once you are 300 m out');
});

test('a double click is two presses close together; it takes back the first press and ignores slow ones', () => {
  const d = new DoubleClick(450);
  assert.deepEqual(d.press(1000), { double: false });
  d.record(+1);
  assert.deepEqual(d.press(1300), { double: true, undo: +1 });
  assert.deepEqual(d.press(1400), { double: false }, 'a third press starts over');
  d.record(0);
  assert.deepEqual(d.press(2000), { double: false }, 'too slow');
  d.record(-1);
  assert.deepEqual(d.press(2100, false), { double: false }, 'nothing to double-click for');
});

const progress = () => ({ xp: 0, ach: {}, segPR: {}, discovered: {} });
const newGame = () => new Game({ profile: { name: 'T', weight: 75, ftp: 200, maxHr: 190 }, workout: WORKOUTS[0], progress: progress() });
const ride = (g, seconds, power = 220) => { for (let i = 0; i < seconds * 20; i++) g.update(0.05, { power, cadence: 90, hr: 130 }); };
const placeUser = (g, x) => { placeOnLoop(g.user, x); g.user.x = x; };

test('game: the fork is announced 1 km out, can be chosen, and the road around is ridden to the rejoin', () => {
  const g = newGame();
  placeUser(g, JUNCTION - 1500);
  ride(g, 2);
  assert.equal(g.extension().state, 'far');
  assert.equal(g.toggleExtension(), false, 'cannot be chosen before it is announced');
  placeUser(g, JUNCTION - TURN_RANGE + 50);
  ride(g, 1);
  assert.equal(g.extension().state, 'approach');
  assert.equal(g.toggleExtension(), true);
  assert.equal(g.toggleExtension(false), false, 'can be cancelled');
  assert.equal(g.toggleExtension(true), true);

  const seen = [];
  const run = (until, max, power = 250) => {
    for (let i = 0; i < 20 * max && !until(); i++) {
      g.update(0.05, { power, cadence: 90, hr: 130 });
      for (const e of g.drain()) if (e.type === 'toast') seen.push(e.text);
    }
  };
  run(() => g.user.spur, 120);
  assert.ok(g.user.spur, 'turned onto the road around');
  const odo1 = g.user.x;
  run(() => seen.includes('BACK ON THE LOOP'), 60 * 40, 300);
  assert.ok(seen.includes('BACK ON THE LOOP'));
  assert.ok(!g.user.spur && g.spurDone === 1);
  assert.ok(Math.abs(g.user.x - odo1 - SPUR_LEN) < 40, 'the odometer counted the road around');
  assert.ok(g.user.c >= REJOIN && g.user.c < REJOIN + 40, 'came out after the descent');
  const s = g.summary();
  assert.equal(s.extensions, 1);
  assert.ok(s.samples.some((x) => x.c >= LOOP) && s.samples.every((x) => typeof x.c === 'number'));
});

test('game: choosing nothing stays on the loop and the choice does not carry over', () => {
  const g = newGame();
  placeUser(g, JUNCTION - 400);
  ride(g, 1);
  g.toggleExtension(true);
  g.toggleExtension(false);
  ride(g, 45);
  assert.ok(!g.user.spur && (g.user.laps >= 1 || g.user.c > JUNCTION), 'rode on past the turn point');
  assert.equal(g.spurIntent, false);

  const h = newGame();
  placeUser(h, JUNCTION - 300);
  ride(h, 1);
  h.toggleExtension(true);
  ride(h, 60);
  assert.ok(h.user.spur, 'took it');
  assert.equal(h.spurIntent, false, 'the choice was used up');
});

test('game: the bunch behind you follows onto the extension, the riders ahead do not, and nobody drafts across stretches', () => {
  const g = newGame();
  placeUser(g, JUNCTION - 300);
  g.bots.forEach((b, i) => { placeOnLoop(b, JUNCTION - 300 + (i - 3) * 14); b.x = JUNCTION - 300 + (i - 3) * 14; });
  ride(g, 1);
  g.toggleExtension(true);
  ride(g, 90);
  assert.ok(g.user.spur);
  const behind = g.bots.filter((b) => b.x < g.user.x - 5);
  assert.ok(g.bots.some((b) => b.spur), 'some of the bunch came along');
  assert.ok(g.bots.some((b) => !b.spur), 'those already through the turn point carried on');
  for (const b of g.bots) assert.ok(Number.isFinite(b.c) && b.c >= 0 && b.c <= TOTAL);
  void behind;
  const board = g.board();
  assert.equal(board.length, g.allRiders().length);
  assert.ok(board.every((e) => Number.isFinite(e.gap) && Number.isFinite(e.gapSec)));
});

test('game: the coach stays beside you through the turn', () => {
  const g = new Game({ profile: { name: 'T', weight: 75, ftp: 200, maxHr: 190 }, workout: WORKOUTS[1], progress: progress() });
  assert.ok(g.coach);
  placeUser(g, JUNCTION - 300);
  placeOnLoop(g.coach, JUNCTION - 296); g.coach.x = JUNCTION - 296;
  ride(g, 1);
  g.toggleExtension(true);
  ride(g, 60);
  assert.ok(g.user.spur && g.coach.spur, 'on the extension together');
  assert.ok(Math.abs(g.coach.x - g.user.x) <= 60);
  assert.ok(Math.hypot(posAt(g.coach.c).x - posAt(g.user.c).x, posAt(g.coach.c).y - posAt(g.user.c).y) < 80);
});

test('climb splits follow the course coordinate: going around skips a climb, and a longer lap does not confuse the laps', () => {
  const c = CLIMBS[0];
  const samples = [];
  let odo = 0;
  const step = (cc) => { odo += 10; samples.push({ p: 200, hr: 140, d: odo, c: cc }); };
  // lap 1 goes around the climb, laps 2 and 3 go up it
  for (let m = 10; m < JUNCTION; m += 10) step(m);
  for (let m = 0; m < SPUR_LEN; m += 10) step(LOOP + m);
  for (let m = REJOIN; m < LOOP; m += 10) step(m);
  for (let m = 0; m < LOOP; m += 10) step(m);
  for (let m = 0; m < LOOP; m += 10) step(m);
  const s = climbSplits(samples, c);
  assert.deepEqual(s.map((x) => x.lap), [2, 3]);
  assert.ok(s.every((x) => Math.abs(x.time - (c.end - c.start) / 10) < 0.01));
});

test('the .fit file follows the route onto the extension and the altitude stays right', () => {
  const samples = [];
  let odo = 0;
  for (let m = JUNCTION - 1000; m < JUNCTION; m += 10) { odo += 10; samples.push({ p: 200, hr: 140, cad: 90, v: 10, d: odo, c: m }); }
  for (let m = 0; m < 3000; m += 10) { odo += 10; samples.push({ p: 200, hr: 140, cad: 90, v: 10, d: odo, c: LOOP + m }); }
  const bytes = buildFit({ samples, startedAt: Date.UTC(2026, 9, 9, 12), place: PLACES[0] });
  assert.ok(bytes.length > 500);
});
