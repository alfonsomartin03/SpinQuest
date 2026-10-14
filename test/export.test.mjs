// Ride export checks: run with `node --test test/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, FIT_EPOCH } from '../js/fit.js';
import { buildFit, projector, PLACES, MIN_SECONDS } from '../js/export.js';
import { posAt, headingAt, elevation, gradeAt, LOOP, SPURS, TOTAL, spurAt } from '../js/course.js';
import { placeOnLoop, advance } from '../js/route.js';

const R = 6371008.8;
const haversine = (a, b) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const bearing = (a, b) => { // radians clockwise from north
  const rad = Math.PI / 180;
  const dl = (b.lon - a.lon) * rad;
  return Math.atan2(Math.sin(dl) * Math.cos(b.lat * rad), Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dl));
};

/** Just enough of a FIT reader to get the messages back out. */
function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headSize = bytes[0];
  const dataSize = dv.getUint32(4, true);
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), '.FIT');
  assert.equal(dv.getUint16(12, true), crc16(bytes.subarray(0, 12)), 'header crc');
  assert.equal(headSize + dataSize + 2, bytes.length, 'size in header');
  assert.equal(dv.getUint16(bytes.length - 2, true), crc16(bytes.subarray(0, bytes.length - 2)), 'file crc');
  const defs = {};
  const out = [];
  let o = headSize;
  while (o < headSize + dataSize) {
    const h = bytes[o++];
    const local = h & 0x0f;
    if (h & 0x40) {
      const global = dv.getUint16(o + 2, true);
      const n = bytes[o + 4];
      o += 5;
      const fields = [];
      for (let i = 0; i < n; i++) fields.push({ num: bytes[o], size: bytes[o + 1], type: bytes[o + 2] }), (o += 3);
      defs[local] = { global, fields };
    } else {
      const { global, fields } = defs[local];
      const msg = { global };
      for (const f of fields) {
        let v = 0n;
        for (let i = f.size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[o + i]);
        if (f.type === 0x85) v = BigInt.asIntN(32, v);
        if (f.type === 0x83) v = BigInt.asIntN(16, v);
        msg[f.num] = Number(v);
        o += f.size;
      }
      out.push(msg);
    }
  }
  return out;
}

// a 25 minute ride that goes once round the loop and a bit
const ride = {
  samples: Array.from({ length: 1500 }, (_, i) => ({ p: 150 + (i % 7), hr: i % 50 === 0 ? null : 140, cad: 90, v: 7.5, d: (i + 1) * 7.5 })),
  startedAt: Date.UTC(2026, 9, 9, 12, 0, 0),
};

test('the file is a valid FIT activity with one record per second', () => {
  const msgs = decode(buildFit({ ...ride, place: PLACES[0] }));
  const records = msgs.filter((m) => m.global === 20);
  assert.equal(records.length, 1500);
  assert.equal(records[0][253], Math.floor(ride.startedAt / 1000) - FIT_EPOCH + 1);
  assert.equal(records[1499][253] - records[0][253], 1499);
  const [session] = msgs.filter((m) => m.global === 18);
  assert.equal(session[5], 2, 'cycling');
  assert.equal(session[6], 58, 'virtual activity');
  assert.equal(msgs.at(-1).global, 34, 'activity message closes the file');
});

test('route length equals recorded distance, at every place', () => {
  for (const place of PLACES) {
    const rec = decode(buildFit({ ...ride, place })).filter((m) => m.global === 20);
    const pts = rec.map((m) => ({ lat: (m[0] * 180) / 2 ** 31, lon: (m[1] * 180) / 2 ** 31 }));
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
    const dist = (rec.at(-1)[5] - rec[0][5]) / 100;
    assert.ok(Math.abs(len - dist) / dist < 0.005, `${place.id}: ${len} vs ${dist}`);
  }
});

test('altitude and grade follow the course profile', () => {
  const rec = decode(buildFit({ ...ride, place: PLACES[0] })).filter((m) => m.global === 20);
  rec.forEach((m, i) => {
    const alt = m[2] / 5 - 500;
    assert.ok(Math.abs(alt - elevation(ride.samples[i].d % LOOP)) < 0.11, `alt at ${i}`);
  });
  const [session] = decode(buildFit({ ...ride, place: PLACES[0] })).filter((m) => m.global === 18);
  assert.ok(session[22] > 150, 'it climbs the pass');
});

test('the bends in the file are the bends of the course', () => {
  const where = projector(PLACES[0]);
  for (let d = 100; d < LOOP; d += 250) {
    const a = where(d - 10), b = where(d + 10);
    // headingAt is a maths angle (anticlockwise from east); a compass bearing runs clockwise from north
    const expected = Math.PI / 2 - headingAt(d);
    const diff = Math.atan2(Math.sin(bearing(a, b) - expected), Math.cos(bearing(a, b) - expected));
    assert.ok(Math.abs(diff) < 0.05, `heading at ${d}: ${diff}`);
  }
});

test('the whole course (loop, flat road, link and Death Road) is placed in open sea around the chosen spot, and the loop closes', () => {
  const where = projector(PLACES[0]);
  let far = 0;
  for (let c = 0; c <= TOTAL; c += 50) { if (c > LOOP && SPURS.every((sp) => c < sp.base || c > sp.end)) continue; far = Math.max(far, haversine(where(c), PLACES[0])); }
  assert.ok(far < 6000, `${far.toFixed(0)} m from the centre at the furthest`);
  assert.ok(haversine(where(LOOP - 1), where(0)) < 2, 'loop closes');
});

// ---- rides that leave the loop: the file must follow the road ridden, join for join ----------------------------------------

/** One sample a second at `v` m/s along a route: `take(spur)` decides each fork. Returns the samples, as the game records them. */
function rideRoute(take, v = 8, until = (r) => r.laps >= 1) {
  const r = placeOnLoop({}, 0);
  const samples = [];
  let d = 0;
  while (!until(r) && samples.length < 12000) {
    advance(r, v, take);
    d += v;
    samples.push({ p: 200, hr: 140, cad: 90, v, d, c: r.c });
  }
  return samples;
}
const [FLAT, DEATH, LINK] = SPURS;
const routes = {
  'the loop': { take: () => false },
  'the flat road all the way round': { take: (sp) => sp === FLAT },
  'the flat road, then the link back to the loop': { take: (sp) => sp === FLAT || sp === LINK },
  'Death Road': { take: (sp) => sp === DEATH },
};

test('a ride on any route is one continuous path: every second moves you the speed you rode, with no jump at a fork or a rejoin', () => {
  for (const [name, { take }] of Object.entries(routes)) {
    const samples = rideRoute(take);
    const rec = decode(buildFit({ samples, startedAt: ride.startedAt, place: PLACES[0] })).filter((m) => m.global === 20);
    const pts = rec.map((m) => ({ lat: (m[0] * 180) / 2 ** 31, lon: (m[1] * 180) / 2 ** 31 }));
    let worst = 0;
    for (let i = 1; i < pts.length; i++) worst = Math.max(worst, Math.abs(haversine(pts[i - 1], pts[i]) - 8));
    assert.ok(worst < 0.35, `${name}: a step differs from the speed ridden by ${worst.toFixed(2)} m`);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
    const dist = (rec.at(-1)[5] - rec[0][5]) / 100;
    assert.ok(Math.abs(len - dist) / dist < 0.004, `${name}: route ${len.toFixed(0)} m vs recorded distance ${dist.toFixed(0)} m`);
    // it starts and ends at the start line
    assert.ok(haversine(pts[0], projector(PLACES[0])(0)) < 10 && haversine(pts.at(-1), projector(PLACES[0])(0)) < 10, `${name}: starts and finishes at the line`);
  }
});

test('altitude and grade in the file are the road ridden, including on the flat road and the link', () => {
  for (const [name, { take }] of Object.entries(routes)) {
    const samples = rideRoute(take);
    const rec = decode(buildFit({ samples, startedAt: ride.startedAt, place: PLACES[0] })).filter((m) => m.global === 20);
    let worstAlt = 0, jump = 0;
    rec.forEach((m, i) => {
      worstAlt = Math.max(worstAlt, Math.abs(m[2] / 5 - 500 - elevation(samples[i].c)));
      assert.ok(Math.abs(m[9] / 10000 - gradeAt(samples[i].c)) < 2e-4, `${name}: grade at ${i}`);
      if (i) jump = Math.max(jump, Math.abs(m[2] - rec[i - 1][2]) / 5);
    });
    assert.ok(worstAlt < 0.11, `${name}: altitude off by ${worstAlt.toFixed(2)} m`);
    assert.ok(jump < 1.2, `${name}: altitude jumps ${jump.toFixed(2)} m between seconds (8 m of road)`); // a 10% grade over 8 m is 0.8 m
  }
});

test('the bends in the file are the bends of the flat road, the link and Death Road', () => {
  const where = projector(PLACES[0]);
  for (const sp of SPURS) {
    for (let s = 60; s < sp.len - 60; s += 200) {
      const c = sp.base + s;
      const a = where(c - 10), b = where(c + 10);
      const expected = Math.PI / 2 - headingAt(c);
      const diff = Math.atan2(Math.sin(bearing(a, b) - expected), Math.cos(bearing(a, b) - expected));
      assert.ok(Math.abs(diff) < 0.06, `${sp.id}: heading ${s} m along: ${diff.toFixed(3)}`);
    }
  }
});

test('the flat road\'s first and last metres sit exactly on the loop, and the link\'s on the flat road and the loop', () => {
  const where = projector(PLACES[0]);
  const same = (a, b) => haversine(where(a), where(b)) < 0.2;
  assert.ok(same(FLAT.base, FLAT.fork), 'the flat road leaves the loop where it says');
  assert.ok(same(FLAT.end, 0), 'and comes back at the start line');
  assert.ok(same(LINK.base, LINK.fork), 'the link leaves the flat road where it says');
  assert.ok(same(LINK.end, LINK.rejoin), 'and joins the loop where it says');
  assert.ok(same(DEATH.base, DEATH.fork) && same(DEATH.end, 0), 'Death Road, as before');
  assert.equal(spurAt(LINK.fork), FLAT.index, 'the link forks from the flat road');
});

test('missing heart rate and cadence are written as invalid, not zero', () => {
  const samples = ride.samples.map((s) => ({ ...s, hr: null, cad: null }));
  const msgs = decode(buildFit({ samples, startedAt: ride.startedAt, place: PLACES[0] }));
  assert.equal(msgs.find((m) => m.global === 20)[4], 0xff);
  assert.ok(!(3 in msgs.find((m) => m.global === 20)), 'no heart-rate field at all');
  assert.equal(msgs.find((m) => m.global === 18)[16], 0xff);
  assert.ok(MIN_SECONDS >= 2);
});

test('climb splits: one per complete ascent, timed foot to top', async () => {
  const { climbSplits, CLIMBS } = await import('../js/course.js');
  const c = CLIMBS[0];
  // 2 laps at 10 m/s: the climb is 3100 m so each ascent takes 310 s; the third lap is cut short on the climb
  const samples = Array.from({ length: 2300 }, (_, i) => ({ p: 200, hr: 150, v: 10, d: (i + 1) * 10 }));
  const s = climbSplits(samples, c);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].time - 310) < 0.01 && Math.abs(s[1].time - 310) < 0.01);
  assert.equal(Math.round(s[0].avgPower), 200);
});
