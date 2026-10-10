// World geometry checks: run with `node --test test/`. Three.js is resolved from the vendored copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const three = pathToFileURL(path.join(root, 'vendor/three/three.module.min.js')).href;
const addons = pathToFileURL(path.join(root, 'vendor/three/addons/')).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === 'three') return { url: '${three}', shortCircuit: true };
  if (s.startsWith('three/addons/')) return { url: '${addons}' + s.slice('three/addons/'.length), shortCircuit: true };
  return n(s, c);
}`));

const geo = await import('../js/world/geo.js');
const { TerrainField, LAKE, RIVER, lakeR } = await import('../js/world/terrain.js');
const { massHeight, MASS_H } = await import('../js/world/structures.js');
const course = await import('../js/course.js');

// At the fork and the rejoin two roads share a few hundred metres at slightly different stations, so the ground between them
// cannot match both to the centimetre; everywhere else the tolerances are strict.
const nearTurn = (d) => {
  if (d >= course.LOOP) { const sp = course.SPURS[course.spurAt(d)]; return d - sp.base < 450 || sp.end - d < 450; }
  const apart = (a, b) => { const x = Math.abs(a - b) % course.LOOP; return Math.min(x, course.LOOP - x); }; // distance round the loop
  return course.SPURS.some((sp) => apart(d, sp.fork) < 450 || apart(d, sp.rejoin) < 450);
};

const field = new TerrainField();
field.buildGrids();

test('road frames are continuous and the loop closes', () => {
  let prev = geo.frame(0);
  for (let d = 1; d < course.LOOP; d++) {
    const f = geo.frame(d);
    assert.ok(Math.hypot(f.x - prev.x, f.z - prev.z) < 1.05, `gap at ${d}`);
    assert.ok(Math.abs(f.y - prev.y) < 0.35, `jump in height at ${d}`);
    prev = f;
  }
  const a = geo.frame(0), b = geo.frame(course.LOOP - 0.01);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.1);
});

test('each detour leaves the loop at its fork and rejoins it, with the same position, height and heading', () => {
  for (const sp of course.SPURS) {
    const f = geo.frame(sp.fork), r = geo.frame(sp.rejoin % course.LOOP), s0 = geo.frame(sp.base), s1 = geo.frame(sp.end);
    for (const [p, q, what] of [[s0, f, 'fork'], [s1, r, 'rejoin']]) {
      assert.ok(Math.hypot(p.x - q.x, p.z - q.z) < 0.05, `${sp.id} meets the road at the ${what}`);
      assert.ok(Math.abs(p.y - q.y) < 0.05, `${sp.id} is at the same height at the ${what}`);
      assert.ok(Math.hypot(p.tx - q.tx, p.tz - q.tz) < 0.06, `${sp.id} heads the same way at the ${what}`);
    }
    let prev = s0;
    for (let d = sp.base + 1; d <= sp.end; d++) {
      const g = geo.frame(d);
      assert.ok(Math.hypot(g.x - prev.x, g.z - prev.z) < 1.05, `${sp.id}: gap at ${d}`);
      assert.ok(Math.abs(g.y - prev.y) < 0.35, `${sp.id}: jump in height at ${d}`);
      prev = g;
    }
  }
});

test('Valley Road is mostly flat; both detours stay well clear of the loop away from their ends', () => {
  const [valley, death] = course.SPURS;
  let steep = 0, n = 0;
  for (let s = 600; s <= valley.len - 600; s += 10) { n++; if (Math.abs(course.gradeAt(valley.base + s)) > 0.03) steep++; } // beyond the ends, where it takes the loop's own profile
  assert.ok(steep / n < 0.03, `${steep} of ${n} samples steeper than 3%`);
  assert.ok(valley.len > 8000 && valley.len < 12000, `${valley.len} m`);
  for (const sp of course.SPURS) {
    let near = Infinity;
    for (let s = 1000; s <= sp.len - 1000; s += 25) {
      const p = geo.frame(sp.base + s);
      for (let d = 0; d < course.LOOP; d += 25) { const q = geo.frame(d); near = Math.min(near, Math.hypot(p.x - q.x, p.z - q.z)); }
    }
    assert.ok(near > (sp.id === 'death' ? 200 : 300), `${sp.id} comes within ${near.toFixed(0)} m of the loop`);
  }
  assert.ok(death.len > 13000 && death.len < 16000, `${death.len} m`);
});

test('the terrain sits just under the road all the way round (except tunnel and bridge)', () => {
  let worst = 0, worstTurn = 0;
  for (let d = 0; d < course.TOTAL; d += 5) {
    if (d > course.LOOP && course.SPURS.every((sp) => d < sp.base || d > sp.end)) continue; // the unused gap between detours
    if (course.onViaduct(d)) continue; // the road is on a viaduct there; the ground follows the road beneath
    if ((d > course.TUNNEL.start - 25 && d < course.TUNNEL.end + 25) || Math.abs(d - course.BRIDGE.x) < 30) continue;
    const f = geo.frame(d);
    for (const lat of [-4.5, 0, 4.5]) {
      const err = Math.abs(field.height(f.x + f.rx * lat, f.z + f.rz * lat) - (f.y - 0.12));
      if (nearTurn(d)) worstTurn = Math.max(worstTurn, err); else worst = Math.max(worst, err);
    }
  }
  assert.ok(worst < 0.1, `corridor error ${worst}`);
  assert.ok(worstTurn < 0.4, `corridor error at the fork and rejoin ${worstTurn}`);
});

test('the tunnel hill is a built mesh and the terrain never covers the road, even at the portals', () => {
  assert.ok(massHeight(0) > 15 && massHeight(0) === MASS_H, 'hill is taller than the bore');
  assert.ok(massHeight(31.9) < 2, 'it blends into the ground at the sides');
  const b = geo.frame(course.BRIDGE.x);
  assert.ok(field.height(b.x, b.z) < b.y - 4, 'stream bed under the deck');
});

test('the lake never touches or floods the road, and the stream runs downhill into it', () => {
  let nearest = Infinity;
  for (let d = 0; d < course.LOOP; d += 4) {
    const f = geo.frame(d);
    for (const lat of [-6, 0, 6]) nearest = Math.min(nearest, lakeR(f.x + f.rx * lat, f.z + f.rz * lat));
    if (lakeR(f.x, f.z) < 1.6) assert.ok(f.y > LAKE.level + 0.5, `road at d=${d} is not above the water`);
  }
  assert.ok(nearest > 1.12, `the road comes within ${nearest.toFixed(2)} of the shoreline radius`);
  const lakeMid = field.height(LAKE.cx, LAKE.cz);
  assert.ok(lakeMid < LAKE.level - 1, `lake bed ${lakeMid} vs level ${LAKE.level}`);
  const { level, bridgeIdx } = RIVER;
  for (let i = bridgeIdx; i < level.length - 1; i++) assert.ok(level[i + 1] <= level[i] + 1e-6, 'downstream never rises');
  assert.ok(Math.abs(level.at(-1) - LAKE.level) < 0.5, 'stream meets the lake');
});

test('mountains rise well above the road far from it', () => {
  let max = -1e9;
  for (let x = -2500; x <= 4000; x += 150) for (let z = -4000; z <= 1500; z += 150) max = Math.max(max, field.height(x, z));
  assert.ok(max > 380, `highest peak ${max}`); // the road around the outside now skirts the highest ground
});

test('the drawn terrain mesh (a coarse 10 m grid) never rises above the road surface', () => {
  // mirrors how scene3d builds the inner mesh: 10 m cells, triangles (a,c,b) and (b,c,d)
  const CELL = 10;
  const x0 = geo.BOUNDS.minX - 560, z0 = geo.BOUNDS.minZ - 560; // FINE_R + 60, as in scene3d
  const cache = new Map();
  const H = (ix, iz) => { const k = ix * 100000 + iz; if (!cache.has(k)) cache.set(k, field.height(x0 + ix * CELL, z0 + iz * CELL)); return cache.get(k); };
  const meshY = (x, z) => {
    const fx = (x - x0) / CELL, fz = (z - z0) / CELL;
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const a = H(ix, iz), b = H(ix + 1, iz), c = H(ix, iz + 1), d = H(ix + 1, iz + 1);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  };
  let worst = -1e9, at = '', worstTurn = -1e9;
  for (let d = 0; d < course.TOTAL; d += 3) {
    if (d > course.LOOP && course.SPURS.every((sp) => d < sp.base || d > sp.end)) continue;
    if (course.onViaduct(d)) continue;
    const p = geo.frame(d);
    for (const lat of [-5.8, -4.5, -2.2, 0, 2.2, 4.5, 5.8]) {
      const err = meshY(p.x + p.rx * lat, p.z + p.rz * lat) - p.y;
      if (nearTurn(d)) worstTurn = Math.max(worstTurn, err);
      else if (err > worst) { worst = err; at = `d=${d} lat=${lat}`; }
    }
  }
  assert.ok(worst < -0.02, `terrain pokes ${worst.toFixed(2)} m above the road at ${at}`);
  assert.ok(worstTurn < 0.12, `terrain pokes ${worstTurn.toFixed(2)} m above the road at the turn point`);
});

test('Death Road spirals: three loops cross over their own road on viaducts, well above it and clear of it at the span ends', () => {
  const death = course.SPURS[1];
  assert.equal(course.VIADUCTS.length, 3);
  for (const v of course.VIADUCTS) {
    assert.equal(v.spur, death.index);
    assert.ok(v.drop > 40, `deck only ${v.drop.toFixed(0)} m above the road below`);
    const up = geo.frame(v.centre), low = geo.frame(v.lower);
    assert.ok(Math.hypot(up.x - low.x, up.z - low.z) < 10, 'the two roads cross in the plan view');
    assert.ok(up.y - low.y > 60, 'with the upper one well above (the world exaggerates height)');
    // 80 m either side the upper road must have left the lower one far enough behind for the ground to climb to it
    for (const e of [v.c0, v.c1]) {
      const g = geo.frame(e);
      assert.ok(Math.hypot(g.x - low.x, g.z - low.z) > 60, 'the span ends well clear of the road below');
    }
  }
  // the ground under a viaduct follows the road beneath it, not the deck
  const v = course.VIADUCTS[0], up = geo.frame(v.centre), low = geo.frame(v.lower);
  assert.ok(field.height(up.x, up.z) < low.y + 12, `ground under the deck is ${field.height(up.x, up.z).toFixed(0)}, deck at ${up.y.toFixed(0)}`);
  assert.ok(field.height(up.x, up.z) < up.y - 40);
});
