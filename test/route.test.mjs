// The forks (the flat road at the foot of the climb, with its link back to the loop, and Death Road late in the lap): where riders are, how they get on and
// off the detours, and the controls that choose them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOP, SPURS, DEATH_AVG_GRADE, posAt, headingAt, elevation, climbSplits, CLIMBS, biomeIndex, BIOMES, spurAt } from '../js/course.js';
import { placeOnLoop, advance, courseAt, roadX, gapBetween, sameStretch } from '../js/route.js';
import { DoubleClick } from '../js/click.js';
import { Game, TURN_RANGE } from '../js/game.js';
import { speedFromPower, gradeAt } from '../js/physics.js';
import { WORKOUTS } from '../js/workouts.js';
import { buildFit, PLACES } from '../js/export.js';

const [V, D, K] = SPURS; // the flat road (Meadow Mile), Death Road, the link back to the loop
const JUNCTION = V.fork, REJOIN = V.rejoin, SPUR_LEN = V.len, TOTAL = V.end;
const rider = (x = 0) => placeOnLoop({}, x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('the flat road leaves the loop at the foot of the climb and comes back to it at the start line, with the same heading and height', () => {
  for (const [c, at] of [[LOOP, JUNCTION], [TOTAL, 0]]) {
    assert.ok(dist(posAt(c), posAt(at)) < 0.01, `position at ${c}`);
    assert.ok(Math.abs(elevation(c) - elevation(at)) < 0.01, `height at ${c}`);
    const dh = headingAt(c) - headingAt(at);
    assert.ok(Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))) < 0.05, `heading at ${c}`);
  }
  assert.equal(TOTAL - LOOP, SPUR_LEN);
  assert.equal(JUNCTION, CLIMBS[0].start, 'the fork is at the base of the climb');
  assert.equal(REJOIN, LOOP, 'it ends at the start / finish line');
  assert.equal(biomeIndex(V.base + 100), BIOMES.length - 3);
  assert.equal(biomeIndex(D.base + 100), BIOMES.length - 2);
  assert.equal(biomeIndex(K.base + 100), BIOMES.length - 1);
});

test('without going around a lap is 10 km and the rider never leaves the loop', () => {
  const r = rider(0);
  const events = [];
  for (let i = 0; i < 2500; i++) events.push(...advance(r, 10)); // 25 km
  assert.equal(events.filter((e) => e === 'pass').length, 5, 'two forks a lap');
  assert.equal(events.filter((e) => e === 'lap').length, 2);
  assert.equal(r.spur, false);
  assert.ok(Math.abs(r.c - 5000) < 1e-6 && r.laps === 2);
});

test('going around is one road all the way to the start line: the lap is the loop up to the fork, then the whole flat road', () => {
  const r = rider(0);
  const seen = [];
  let travelled = 0;
  while (r.laps < 1) { const ev = advance(r, 7, (sp) => sp === V); travelled += 7; seen.push(...ev.filter((e) => e !== 'lap')); }
  assert.deepEqual(seen, ['enter', 'pass', 'exit'], 'in, past the link back to the loop, out at the line');
  const expected = JUNCTION + SPUR_LEN;
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
  advance(out, JUNCTION, (sp) => sp === V);
  advance(out, SPUR_LEN + 6, (sp) => sp === V);
  assert.ok(!out.spur && Math.abs(out.c - 6) < 1e-6 && out.laps === 1, 'it ends at the start line, a lap later');
  assert.ok(Math.abs(courseAt(out, -10) - (TOTAL - 4)) < 1e-6, 'behind you, still out on the road around');
  const home = rider(D.fork - 5);
  advance(home, 5, () => true);
  advance(home, D.len + 4, () => true);
  assert.ok(!home.spur && Math.abs(home.c - 4) < 1e-6 && home.laps === 1, 'Death Road comes out at the start line, a lap later');
  assert.ok(Math.abs(courseAt(home, -10) - (D.end - 6)) < 1e-6, 'and behind you is the end of it');
});

test('road positions and gaps: the road around is placed by progress along the stretch it replaces', () => {
  const a = rider(1000), b = rider(1400), far = rider(1400);
  advance(far, 100 + 0, (sp) => sp === V); // reaches the fork and turns off (1500)
  assert.ok(far.spur && Math.abs(far.c - LOOP) < 1e-9);
  assert.equal(gapBetween(a, b), 400);
  assert.equal(roadX(far), JUNCTION);
  advance(far, SPUR_LEN / 2, () => false);
  assert.ok(Math.abs(roadX(far) - (JUNCTION + (REJOIN - JUNCTION) / 2)) < 1e-6, 'halfway round is halfway through what it replaces');
  const other = rider(1400); advance(other, 100 + 300, (sp) => sp === V);
  assert.ok(Math.abs(gapBetween(far, other) - (other.c - far.c)) < 1e-9, 'two riders on it use real distance');
  const f2 = rider(1400); advance(f2, 100 + 20 + 300, (sp) => sp === V);
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

test('game: the fork is announced 1 km out, can be chosen, and the flat road is ridden all the way to the start line', () => {
  const g = newGame();
  placeUser(g, JUNCTION - 1500);
  ride(g, 2);
  assert.equal(g.extension().state, 'far');
  assert.equal(g.extension().spur, V, 'the next fork is the flat road');
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
  assert.ok(g.user.spur, 'turned onto the flat road');
  assert.equal(g.spurIntent, false, 'and nothing else is chosen: it just goes on');
  // jump to the last 300 m
  const odo = g.user.x;
  advance(g.user, V.len - 300 - (g.user.c - V.base), () => false);
  g.user.x = odo + V.len - 300;
  run(() => seen.includes('Lap complete!'), 120, 300);
  assert.ok(seen.includes('Lap complete!'), 'came in to the start line');
  assert.ok(!g.user.spur && g.spurDone === 1 && g.user.laps === 1 && g.user.c < 60, 'a lap done, back on the loop at the line');
  const s = g.summary();
  assert.equal(s.extensions, 1);
  assert.deepEqual(s.detours, { valley: 1 });
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

test('game: the bunch behind you follows you onto a detour, the riders ahead do not, and the board stays sane', () => {
  const g = newGame();
  placeUser(g, JUNCTION - 300);
  const offsets = [-40, -30, -20, 250, 270, 290]; // three behind you, three well ahead and through the fork long before you
  g.bots.forEach((b, i) => { placeOnLoop(b, JUNCTION - 300 + offsets[i]); b.x = JUNCTION - 300 + offsets[i]; });
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

test('Death Road: a switchback climb averaging 8-9% that takes about 20 minutes at 6.5 W/kg, then a short spiral descent to the finish', () => {
  const climb = CLIMBS.find((c) => c.id === 'death');
  assert.equal(climb.start, D.base);
  const len = climb.end - climb.start;
  const gain = elevation(climb.end) - elevation(climb.start);
  assert.ok(Math.abs(gain / len - DEATH_AVG_GRADE) < 0.002, `average grade ${(gain / len * 100).toFixed(2)}%`);
  assert.ok(gain / len > 0.08 && gain / len < 0.09);
  // time it with the game's own physics: a 75 kg rider at 6.5 W/kg
  let t = 0;
  for (let m = 0; m < len; m += 5) t += 5 / speedFromPower(6.5 * 75, gradeAt(climb.start + m), 84);
  assert.ok(t > 18.5 * 60 && t < 21.5 * 60, `climb takes ${(t / 60).toFixed(1)} min`);
  // the descent after the summit never gets steeper than a steady 7% and runs all the way back to the finish
  let steepest = 0;
  for (let m = 120; m < D.len - climb.end + D.base - 600; m += 5) steepest = Math.min(steepest, gradeAt(climb.end + 200 + m));
  assert.ok(steepest > -0.125, `descent as steep as ${(steepest * 100).toFixed(1)}%`);
  assert.ok(Math.abs(elevation(D.end) - elevation(0)) < 0.01, 'it finishes at the level of the start line');
  const descent = D.len - D.climb;
  assert.ok(descent > 6000 && descent < 8500, `the spirals keep the descent short: ${descent} m`);
  assert.ok(((elevation(climb.end) - elevation(D.end)) / descent) > 0.08, 'steeper than the climb is gentle, because it is short');
});

test('game: Death Road is announced 1 km out, ridden to the start line, and counts as a lap', () => {
  const g = newGame();
  placeUser(g, D.fork - 500);
  ride(g, 1);
  assert.equal(g.extension().state, 'approach');
  assert.equal(g.extension().spur, D);
  g.toggleExtension(true);
  const seen = [];
  const lapStart = g.user.laps;
  for (let i = 0; i < 20 * 60 * 90 && !seen.includes('Death Road done!'); i++) {
    g.update(0.05, { power: 450, cadence: 90, hr: 150 });
    for (const e of g.drain()) if (e.type === 'toast') seen.push(e.text);
    if (g.user.spur && seen.length === 0) seen.push('(on it)');
  }
  assert.ok(seen.includes('Death Road done!'), `toasts: ${seen.join(', ')}`);
  assert.ok(g.user.laps === lapStart + 1 && g.user.c < 100, 'came out at the start line');
  assert.deepEqual(g.summary().detours, { death: 1 });
  assert.ok(g.user.segTimes.death > 0, 'the Death Road climb segment was timed');
});

test('climb splits work on a detour climb too: Death Road is timed from its foot to the summit, and only when ridden', () => {
  const climb = CLIMBS.find((c) => c.id === 'death');
  const samples = [];
  let odo = 0;
  const step = (cc) => { odo += 8; samples.push({ p: 450, hr: 170, d: odo, c: cc }); };
  for (let m = 6000; m < LOOP; m += 8) step(m); // lap 1 goes straight to the finish
  for (let m = 0; m < D.fork; m += 8) step(m); // lap 2 rides the loop up to the fork ...
  for (let m = 0; m < D.len; m += 8) step(D.base + m); // ... and takes Death Road
  for (let m = 0; m < 2000; m += 8) step(m);
  const s = climbSplits(samples, climb);
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].time - (climb.end - climb.start) / 8) < 1.5, `${s[0].time} s`); // timed from the turn-off, to within a sample
  assert.equal(climbSplits(samples, CLIMBS[0]).length, 1, 'and the Col still counts on the lap that used it');
});

/** Put the game's rider on the flat road, `left` metres from where the link back to the loop leaves it. */
const placeBeforeLink = (g, left) => {
  placeOnLoop(g.user, V.fork - 5);
  advance(g.user, 5 + (K.fork - V.base) - left, () => true);
  g.user.x = V.fork + (K.fork - V.base) - left;
};

test('the link: leaves the flat road in the north-east and joins the loop between the summit and Death Road, matching height and heading at both ends', () => {
  assert.equal(K.parent, V.index);
  assert.deepEqual(V.children, [K.index]);
  assert.ok(K.fork > V.base && K.fork < V.end, 'its fork is on the flat road');
  assert.ok(K.rejoin > CLIMBS[0].end && K.rejoin < D.fork, 'it joins the loop between the top of the climb and Death Road');
  for (const [c, at] of [[K.base, K.fork], [K.end, K.rejoin]]) {
    assert.ok(dist(posAt(c), posAt(at)) < 0.05, `position at ${c}`);
    assert.ok(Math.abs(elevation(c) - elevation(at)) < 0.05, `height at ${c}`);
    const dh = headingAt(c) - headingAt(at);
    assert.ok(Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))) < 0.05, `heading at ${c}`);
  }
  assert.ok(K.len > 800 && K.len < 3000, `a short link: ${K.len} m`);
});

test('the flat road goes right round Death Road: further west, north and south than any of it', () => {
  let minX = Infinity, maxY = -Infinity, minY = Infinity, dMinX = Infinity, dMaxY = -Infinity, dMinY = Infinity;
  for (let s = 0; s <= V.len; s += 20) { const p = posAt(V.base + s); minX = Math.min(minX, p.x); maxY = Math.max(maxY, p.y); minY = Math.min(minY, p.y); }
  for (let s = 0; s <= D.len; s += 20) { const p = posAt(D.base + s); dMinX = Math.min(dMinX, p.x); dMaxY = Math.max(dMaxY, p.y); dMinY = Math.min(dMinY, p.y); }
  assert.ok(minX < dMinX - 600 && maxY > dMaxY + 400 && minY < dMinY - 400, 'a wide berth all the way round');
  assert.ok(V.len > 15000 && V.len < 20000, `one long road: ${V.len} m`);
});

test('routes: flat road to the line, or the flat road then the link back to the loop and on round it', () => {
  // all the way round
  const r = rider(0);
  const seen = [];
  let travelled = 0;
  while (r.laps < 1) { seen.push(...advance(r, 7, (sp) => sp === V)); travelled += 7; }
  assert.deepEqual(seen, ['enter', 'pass', 'exit', 'lap']);
  assert.ok(Math.abs(travelled - (V.fork + V.len)) < 7);
  // off at the link
  const q = rider(0);
  const ev = [];
  let rode = 0;
  while (q.laps < 1) { ev.push(...advance(q, 7, (sp) => sp === V || sp === K)); rode += 7; }
  assert.deepEqual(ev, ['enter', 'enter', 'exit', 'pass', 'lap'], 'onto the flat road, off it at the link, back on the loop, past Death Road, over the line');
  const expected = V.fork + (K.fork - V.base) + K.len + (LOOP - K.rejoin);
  assert.ok(Math.abs(rode - expected) < 7, `lap was ${rode} m, expected ${expected}`);
});

test('courseAt on the link: behind you is the flat road before the fork, and the link after', () => {
  const r = rider(0);
  advance(r, V.fork, () => true);
  advance(r, K.fork - V.base + 30, (sp) => sp === K);
  assert.ok(r.spur && spurAt(r.c) === K.index && Math.abs(r.c - (K.base + 30)) < 1e-6);
  assert.ok(Math.abs(courseAt(r, -10) - (K.base + 20)) < 1e-6);
  assert.ok(Math.abs(courseAt(r, -40) - (K.fork - 10)) < 1e-6, 'before the fork you were on the flat road');
  assert.ok(Math.abs(courseAt(r, 10, false) - (K.base + 40)) < 1e-6);
});

test('game: the link is offered a kilometre before it leaves the flat road, is not taken unless chosen, and puts you back on the loop', () => {
  const g = newGame();
  placeBeforeLink(g, TURN_RANGE + 400);
  ride(g, 1);
  assert.ok(g.user.spur);
  assert.equal(g.extension().state, 'on', 'not announced yet');
  assert.equal(g.toggleExtension(), false, 'cannot be chosen yet');
  placeBeforeLink(g, TURN_RANGE - 200);
  ride(g, 1);
  const x = g.extension();
  assert.equal(x.state, 'approach');
  assert.equal(x.spur, K);
  assert.equal(x.armed, false, 'staying on the flat road is the default');
  assert.ok(x.toTurn < TURN_RANGE && x.toTurn > 0);
  assert.equal(g.toggleExtension(true), true);
  const seen = [];
  for (let i = 0; i < 20 * 400 && !(!g.user.spur && g.user.c > K.rejoin); i++) {
    g.update(0.05, { power: 300, cadence: 90, hr: 140 });
    for (const e of g.drain()) if (e.type === 'toast') seen.push(e.text);
  }
  assert.ok(!g.user.spur && g.user.c > K.rejoin, 'back on the loop after the descent');
  assert.ok(seen.includes('Back on the loop'));
  assert.equal(g.spursDone.link, 1);
});

test('game: left alone the flat road goes straight past the link', () => {
  const g = newGame();
  placeBeforeLink(g, 200);
  ride(g, 1);
  for (let i = 0; i < 20 * 60; i++) g.update(0.05, { power: 300, cadence: 90, hr: 140 });
  assert.ok(g.user.spur && spurAt(g.user.c) === V.index && g.user.c > K.fork, 'still on the flat road, past the link');
});

test('after the flat road is taken the next fork on the loop is still Death Road', () => {
  const g = newGame();
  placeUser(g, K.rejoin + 100);
  ride(g, 1);
  assert.equal(g.extension().spur, D);
  placeUser(g, D.fork + 100);
  ride(g, 1);
  assert.equal(g.extension().spur, null, 'no fork left this lap');
  assert.equal(g.extension().state, 'far');
});
