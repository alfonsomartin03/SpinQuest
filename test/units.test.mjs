// Run with: node --test spinquest/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, parseCyclingPower, parseHeartRate, encodeTargetPower, parseControlResponse, TrainerControl, UUID } from '../js/ble.js';
import { VirtualGears, slew, GEAR_RATIOS } from '../js/gearing.js';
import { speedFromPower, powerFromSpeed, gradeAt, elevation, LOOP, SEGMENTS, powerZone, levelFor, xpForLevel } from '../js/physics.js';
import { WORKOUTS, workoutAt, totalDuration } from '../js/workouts.js';
import { Game } from '../js/game.js';
import { placeOnLoop } from '../js/route.js';
import { TOTAL, posAt, headingAt, LANDMARKS, envAt, CLIMBS, climbStats, activeClimb, elevation as realElev } from '../js/course.js';
import { PROTOCOL_VERSION, sanitizeState, RemoteRider, LoopbackSession, DemoPeers, packRider } from '../js/net.js';

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
  assert.ok(Math.abs(elevation(0) - elevation(LOOP - 1e-6)) < 1e-3);
  for (let d = 0; d < LOOP; d += 25) assert.ok(Math.abs(gradeAt(d)) < 0.105, `grade ${gradeAt(d)} at ${d}`);
  assert.equal(SEGMENTS.length, 5);
  for (const s of SEGMENTS) assert.ok(s.start >= 0 && (s.end <= LOOP || s.start >= LOOP), `${s.id} sits on the loop or on one detour`);
});

test('course geometry closes on itself and has landmarks in zones', () => {
  const a = posAt(0), b = posAt(LOOP - 5);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 8);
  assert.ok(Math.abs(headingAt(LOOP - 1e-6) - headingAt(0)) > 6); // one full turn per lap
  for (const lm of LANDMARKS) assert.ok(lm.d >= 0 && lm.d <= TOTAL && lm.d !== LOOP);
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

test('FTMS control point encoding and responses', () => {
  assert.deepEqual([...encodeTargetPower(250)], [0x05, 250, 0]);
  assert.deepEqual([...encodeTargetPower(1000)], [0x05, 0xe8, 0x03]);
  assert.deepEqual([...encodeTargetPower(-5)], [0x05, 0, 0]);
  assert.deepEqual(parseControlResponse(view([0x80, 0x00, 0x01])), { op: 0, result: 1, ok: true });
  assert.equal(parseControlResponse(view([0x80, 0x00, 0x05])).ok, false);
  assert.equal(parseControlResponse(view([0x01, 0x02])), null);
});

// A fake FTMS service: records writes and replies to "request control" like a real trainer.
function fakeFtms({ reply = 0x01, targetFeature = 1 << 3, hasControl = true } = {}) {
  const writes = [];
  const handlers = [];
  const cp = {
    addEventListener: (_, h) => handlers.push(h),
    startNotifications: async () => {},
    writeValueWithResponse: async (bytes) => {
      writes.push([...bytes]);
      if (bytes[0] === 0x00) setTimeout(() => handlers.forEach((h) => h({ target: { value: view([0x80, 0x00, reply]) } })), 0);
    },
  };
  const feature = { readValue: async () => { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, targetFeature, true); return dv; } };
  const service = {
    getCharacteristic: async (id) => {
      if (id === UUID.FTMS_CONTROL && hasControl) return cp;
      if (id === UUID.FTMS_FEATURE) return feature;
      throw new Error('missing');
    },
  };
  return { service, writes };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('trainer control: acquire, hold power, release', async () => {
  const { service, writes } = fakeFtms();
  const c = new TrainerControl();
  assert.equal(c.state, 'none');
  await c.attach(service);
  assert.equal(c.state, 'idle');
  c.setTargetPower(200); // ignored until we have control
  assert.equal(writes.length, 0);
  c.acquire();
  await tick();
  assert.equal(c.state, 'ready');
  assert.deepEqual(writes.slice(0, 2), [[0x00], [0x07]]); // request control, then start
  c.setTargetPower(180.4);
  c.setTargetPower(180); // duplicate, not re-sent
  await tick();
  assert.deepEqual(writes.filter((w) => w[0] === 0x05), [[0x05, 180, 0]]);
  c.release();
  await tick();
  assert.equal(c.state, 'idle');
  assert.ok(writes.some((w) => w[0] === 0x08)); // stop
  assert.deepEqual(writes.filter((w) => w[0] === 0x05).pop(), [0x05, 0, 0]); // resistance released
});

test('trainer control: denied, unsupported and missing control point', async () => {
  const denied = fakeFtms({ reply: 0x05 });
  const c1 = new TrainerControl();
  await c1.attach(denied.service);
  c1.acquire();
  await tick();
  assert.equal(c1.state, 'denied');
  assert.match(c1.reason, /Another app/);

  const noTarget = new TrainerControl();
  await noTarget.attach(fakeFtms({ targetFeature: 0 }).service);
  assert.equal(noTarget.state, 'none');

  const noCp = new TrainerControl();
  await noCp.attach(fakeFtms({ hasControl: false }).service);
  assert.equal(noCp.state, 'none');
});

test('physics: powerFromSpeed inverts speedFromPower', () => {
  for (const [p, g, d] of [[100, 0, 1], [250, 0.05, 1], [180, -0.03, 0.7], [400, 0.08, 1]]) {
    const v = speedFromPower(p, g, 84, d);
    assert.ok(Math.abs(powerFromSpeed(v, g, 84, d) - p) < 1, `${p}W ${g}`);
  }
  assert.equal(powerFromSpeed(0, 0, 84), 0);
});

test('virtual gears: natural cadence on flat, climbs need an easier gear', () => {
  const g = new VirtualGears({ auto: false });
  const flat = g.targetPower({ cadence: 90, grade: 0, mass: 84 });
  assert.ok(flat > 120 && flat < 260, `flat power at 90 rpm ${flat}`);
  const climb = g.targetPower({ cadence: 90, grade: 0.06, mass: 84 });
  assert.ok(climb > 2 * flat, 'steep road at the same gear and cadence is much harder');
  while (g.targetPower({ cadence: 90, grade: 0.06, mass: 84 }) > 330) g.shift(-1);
  assert.ok(g.gear < 17, 'shifted to an easier gear');
  assert.ok(g.targetPower({ cadence: 60, grade: 0, mass: 84 }) < flat, 'slower cadence = less resistance (no ERG death spiral)');
  assert.ok(GEAR_RATIOS[0] < GEAR_RATIOS.at(-1));
  assert.equal(g.targetPower({ cadence: 0, grade: 0, mass: 84 }), 0);
});

test('virtual gears: auto-shift follows the comfortable range', () => {
  const g = new VirtualGears({ auto: true }); // default 80-100 rpm
  const start = g.gear;
  for (let i = 0; i < 100; i++) g.update(0.1, 106); // above the range for 10 s
  assert.ok(g.gear > start, 'shifted harder');
  const hi = g.gear;
  for (let i = 0; i < 100; i++) g.update(0.1, 74); // below the range
  assert.ok(g.gear < hi, 'shifted easier');

  const inside = new VirtualGears({ auto: true });
  for (let i = 0; i < 200; i++) inside.update(0.1, 90);
  assert.equal(inside.gear, 17, 'no shifting inside the range');

  const sprint = new VirtualGears({ auto: true });
  for (let i = 0; i < 30; i++) sprint.update(0.1, 135);
  assert.equal(sprint.gear, 17, 'a sprint of a few seconds is left alone');
  for (let i = 0; i < 100; i++) sprint.update(0.1, 135);
  assert.ok(sprint.gear > 17, 'but spinning that fast for long is not a sprint');

  const custom = new VirtualGears({ auto: true, low: 70, high: 90 });
  for (let i = 0; i < 100; i++) custom.update(0.1, 76);
  assert.equal(custom.gear, 17, '76 rpm is fine for a 70-90 range');
  for (let i = 0; i < 100; i++) custom.update(0.1, 96);
  assert.ok(custom.gear > 17, '96 rpm is too fast for a 70-90 range');

  const m = new VirtualGears({ auto: true });
  m.shift(-1); // manual
  const held = m.gear;
  for (let i = 0; i < 50; i++) m.update(0.1, 108);
  assert.equal(m.gear, held, 'auto-shift waits after a manual shift');
  const idle = new VirtualGears({ auto: true });
  for (let i = 0; i < 100; i++) idle.update(0.1, 0);
  assert.equal(idle.gear, 17, 'no shifting while not pedalling');
});

test('game: stopping pedalling brakes to a halt (even downhill) and pauses', () => {
  const progress = { xp: 0, ach: {}, segPR: {}, discovered: {} };
  const g = new Game({ profile: { name: 'T', weight: 75, ftp: 200, maxHr: 190 }, workout: WORKOUTS[0], progress });
  placeOnLoop(g.user, 5700); g.user.x = 5700; // a steep descent
  for (let i = 0; i < 20 * 20; i++) g.update(0.05, { power: 200, cadence: 90, hr: 120 });
  assert.ok(g.user.v > 8, 'rolling');
  assert.ok(!g.paused);
  const tStop = g.t;
  let pausedAt = null;
  for (let i = 0; i < 12 * 20; i++) {
    g.update(0.05, { power: 0, cadence: 0, hr: 100 });
    if (g.paused && pausedAt == null) pausedAt = i * 0.05;
  }
  assert.ok(g.user.v < 0.01, `stopped, v=${g.user.v}`);
  assert.ok(pausedAt != null && pausedAt <= 3.2, `paused after ${pausedAt}s`);
  assert.ok(g.t - tStop < 3.5, 'ride time stops counting');
  const x = g.user.x;
  for (let i = 0; i < 40; i++) g.update(0.05, { power: 0, cadence: 0, hr: 100 });
  assert.equal(g.user.x, x, 'no creeping while paused');
  for (let i = 0; i < 20; i++) g.update(0.05, { power: 150, cadence: 85, hr: 100 });
  assert.ok(!g.paused, 'resumes when pedalling again');
});

test('slew limits rises but not drops', () => {
  assert.equal(slew(null, 500, 1), 500);
  assert.equal(slew(100, 900, 1, 300), 400);
  assert.equal(slew(400, 50, 1), 50);
});

test('climb statistics: distance, elevation and grade left', () => {
  const c = CLIMBS[0];
  const len = c.end - c.start;
  const start = climbStats(c, c.start + 1);
  assert.equal(start.state, 'on');
  assert.ok(Math.abs(start.left - (len - 1)) < 1e-6);
  assert.ok(start.elevLeft > 150 && Math.abs(start.avgLeft - start.avgAll) < 0.003, `elevLeft ${start.elevLeft}`);
  const mid = climbStats(c, c.start + len / 2);
  assert.ok(Math.abs(mid.left - len / 2) < 1e-6);
  assert.ok(mid.elevLeft < start.elevLeft && mid.elevLeft > 0);
  assert.ok(Math.abs(mid.progress - 0.5) < 1e-6);
  assert.ok(mid.steepest.grade >= mid.gradeNow - 1e-9, 'steepest ahead is at least the current grade');
  const top = climbStats(c, c.end);
  assert.ok(top.left < 1e-6 && top.elevLeft < 0.01);
  assert.ok(Math.abs(top.summitAlt - realElev(c.end)) < 1e-9);
  const before = climbStats(c, c.start - 300);
  assert.equal(before.state, 'before');
  assert.ok(Math.abs(before.toStart - 300) < 1e-6);
  assert.equal(climbStats(c, c.end + 50).state, 'done');
});

test('the climb panel appears 450 m before the climb and leaves at the top', async () => {
  const c = CLIMBS[0];
  assert.equal(activeClimb(c.start - 500), null);
  assert.equal(activeClimb(c.start - 400).stats.state, 'before');
  assert.equal(activeClimb(c.start + 1000).climb.id, c.id);
  assert.equal(activeClimb(c.end + 10), null);
  assert.ok(activeClimb(c.start + 1000 + Math.ceil(TOTAL / LOOP) * LOOP).climb, 'works on later laps');
  assert.equal(activeClimb(LOOP + 500), null, 'no climb on the extension');
  const { SPURS } = await import('../js/course.js');
  assert.equal(activeClimb(SPURS[0].end - 50), null, 'the end of the flat road is not the start of Death Road');
});

const rstate = (over = {}) => ({ v: PROTOCOL_VERSION, id: 'p1', name: 'Sam', color: '#4cc9f0', t: 1000, x: 100, lat: 0, speed: 10, power: 250, cad: 90, hr: 150, weight: 70, ftp: 250, ...over });

test('network states are validated and clamped', () => {
  assert.ok(sanitizeState(rstate()));
  assert.equal(sanitizeState(null), null);
  assert.equal(sanitizeState(rstate({ v: 99 })), null);
  assert.equal(sanitizeState(rstate({ x: NaN })), null);
  assert.equal(sanitizeState(rstate({ speed: 400 })), null);
  assert.equal(sanitizeState(rstate({ id: '' })), null);
  const s = sanitizeState(rstate({ power: 99999, weight: 5, color: 'red', name: 'x'.repeat(50), hr: 999, lat: 50 }));
  assert.equal(s.power, 2500); assert.equal(s.weight, 30); assert.equal(s.color, '#cccccc'); assert.equal(s.name.length, 16); assert.equal(s.hr, 230); assert.equal(s.lat, 4);
});

test('remote riders are interpolated smoothly despite jitter, and extrapolation is brief', () => {
  const r = new RemoteRider();
  // a rider at a steady 10 m/s sends 10 states a second; packets arrive 100 +- 40 ms late
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const arrivals = [];
  for (let i = 0; i < 40; i++) { const t = 1000 + i * 100; arrivals.push({ s: rstate({ t, x: 100 + i }), at: t + 100 + (rnd() - 0.5) * 80 }); }
  arrivals.sort((a, b) => a.at - b.at);
  let worst = 0;
  for (const a of arrivals) {
    r.push(a.s, a.at);
    const st = r.sample(a.at + 50);
    if (st && r.buf.length > 4) { // true x at the sample's own timestamp
      const trueX = 100 + (a.at + 50 - r.offset - 150 - 1000) / 100;
      worst = Math.max(worst, Math.abs(st.x - trueX));
    }
  }
  assert.ok(worst < 0.8, `interpolation error ${worst} m`);
  const last = arrivals.at(-1).at;
  const starved = r.sample(last + 3000);
  assert.ok(starved.extrapolated);
  const held = r.sample(last + 10000);
  assert.ok(held.x - starved.x < 4.5, 'extrapolation stops after 0.3 s'); // 10 m/s * 0.3 s = 3 m
  assert.equal(r.push(rstate({ t: 1000 }), last), false, 'old packets are ignored');
});

test('game: remote riders join, show up in the sidebar data, and leave', () => {
  const progress = { xp: 0, ach: {}, segPR: {}, discovered: {} };
  const g = new Game({ profile: { name: 'T', weight: 70, ftp: 250, maxHr: 190 }, workout: WORKOUTS[0], progress });
  for (let i = 0; i < 60; i++) g.update(0.05, { power: 180, cadence: 88, hr: 140 });
  assert.equal(g.applyRemote(rstate({ x: g.user.x + 40, t: 0 })), true);
  assert.equal(g.applyRemote({ nonsense: true }), false);
  for (let k = 1; k < 40; k++) { // 4 s of 10 Hz packets
    g.applyRemote(rstate({ t: k * 100, x: g.user.x + 40 + k, speed: 10, power: 320, hr: 168 }));
    for (let i = 0; i < 2; i++) g.update(0.05, { power: 180, cadence: 88, hr: 140 });
  }
  const row = g.board().find((e) => e.r.kind === 'remote');
  assert.ok(row, 'remote rider is on the board');
  assert.equal(row.r.id, 'p1');
  assert.ok(row.gap > 20 && row.gapSec > 0, `gap ${row.gap}`);
  assert.ok(row.r.p3 > 100 && row.r.weight === 70 && row.r.hr > 100);
  assert.ok(g.allRiders().includes(row.r));
  g.removeRemote('p1');
  assert.ok(!g.board().some((e) => e.r.kind === 'remote'));
  // every rider has the fields the sidebar shows
  for (const { r } of g.board()) for (const k of ['id', 'name', 'color', 'x', 'v', 'p3', 'weight', 'ftp', 'kind']) assert.ok(r[k] !== undefined, `${r.name}.${k}`);
});

test('demo peers publish through the loopback with latency and packRider round-trips', async () => {
  let now = 0;
  const queue = [];
  const session = new LoopbackSession({ latencyMs: 80, jitterMs: 0, now: () => now, schedule: (fn, ms) => queue.push({ at: now + ms, fn }) });
  const got = [];
  session.onState((s) => got.push(s));
  const peers = new DemoPeers(session, { count: 2, startX: 0, now: () => now });
  for (let i = 0; i < 30; i++) { now += 50; peers.tick(0.05); for (const q of queue.filter((q) => q.at <= now)) q.fn(); }
  assert.ok(got.length >= 8, `${got.length} states received`);
  assert.ok(got.every((s) => sanitizeState(s)), 'all demo states are valid on the wire');
  const rider = { id: 'a', name: 'A', color: '#112233', x: 5, lat: 1, v: 9, cad: 80, weight: 70, ftp: 250 };
  assert.deepEqual(sanitizeState(packRider(rider, { power: 200, hr: 140, now: 1 })).id, 'a');
});

test('custom heart-rate zone limits', async () => {
  const { hrZone, defaultHrLimits, cleanHrLimits } = await import('../js/physics.js');
  assert.equal(hrZone(150, 190), hrZone(150, 190, null));
  assert.deepEqual(defaultHrLimits(200), [120, 140, 160, 180]);
  assert.equal(hrZone(125, 190, [130, 145, 160, 175]), 0);
  assert.equal(hrZone(146, 190, [130, 145, 160, 175]), 2);
  assert.equal(hrZone(200, 190, [130, 145, 160, 175]), 4);
  assert.equal(cleanHrLimits([140, 130, 160, 170]), null, 'must ascend');
  assert.equal(hrZone(150, 190, [140, 130, 160, 170]), hrZone(150, 190), 'bad limits fall back to % of max');
});

test('Zwift Click button frames fire once per press', async () => {
  const { parseClickButtons } = await import('../js/ble.js');
  const dv = (...b) => new DataView(Uint8Array.from(b).buffer);
  const st = {};
  assert.deepEqual(parseClickButtons(dv(0x37, 0x08, 0xff, 0x10, 0xff), st), [], 'idle');
  assert.deepEqual(parseClickButtons(dv(0x37, 0x08, 0x00, 0x10, 0xff), st), ['plus']);
  assert.deepEqual(parseClickButtons(dv(0x37, 0x08, 0x00, 0x10, 0xff), st), [], 'held: no repeat');
  assert.deepEqual(parseClickButtons(dv(0x37, 0x08, 0xff, 0x10, 0xff), st), [], 'released');
  assert.deepEqual(parseClickButtons(dv(0x37, 0x08, 0xff, 0x10, 0x00), st), ['minus']);
  assert.deepEqual(parseClickButtons(dv(0x01, 0x03), st), [], 'handshake reply ignored');
});

test('physics: no speed cap, and on a steep descent weight decides who passes 80 km/h', () => {
  const kmh = (watts, grade, riderKg) => speedFromPower(watts, grade, riderKg + 9) * 3.6;
  assert.ok(kmh(0, -0.09, 100) > 80, 'a heavy rider coasts past 80 km/h on a 9% descent');
  assert.ok(kmh(0, -0.09, 55) < 75, 'a light rider does not');
  assert.ok(kmh(0, -0.09, 100) > kmh(0, -0.09, 75) && kmh(0, -0.09, 75) > kmh(0, -0.09, 55), 'speed rises with weight downhill');
  assert.ok(kmh(250, -0.12, 75) > 90, 'there is no 79 km/h ceiling any more');
  assert.ok(kmh(250, 0.07, 55) > kmh(250, 0.07, 100), 'but the light rider wins the climb');
  assert.ok(kmh(200, 0, 100) < kmh(200, 0, 60), 'and the flat, a little, because bigger riders are bigger in the wind');
  assert.ok(kmh(300, -0.5, 75) <= 45 * 3.6 + 1e-9, 'the solver still has an outer bound');
  // the inverse still holds at the new speeds
  for (const [p, g, m] of [[0, -0.09, 109], [250, -0.1, 84], [400, -0.12, 70]]) {
    assert.ok(Math.abs(powerFromSpeed(speedFromPower(p, g, m), g, m) - p) < 0.5, `${p} W at ${g} for ${m} kg`);
  }
});
