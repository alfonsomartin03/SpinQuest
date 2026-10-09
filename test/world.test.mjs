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

const field = new TerrainField();
field.buildGrids();

test('road frames are continuous and the loop closes', () => {
  let prev = geo.frame(0);
  for (let d = 1; d <= course.LOOP; d++) {
    const f = geo.frame(d);
    assert.ok(Math.hypot(f.x - prev.x, f.z - prev.z) < 1.05, `gap at ${d}`);
    assert.ok(Math.abs(f.y - prev.y) < 0.35, `jump in height at ${d}`);
    prev = f;
  }
  const a = geo.frame(0), b = geo.frame(course.LOOP - 0.01);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.1);
});

test('the terrain sits just under the road all the way round (except tunnel and bridge)', () => {
  let worst = 0;
  for (let d = 0; d < course.LOOP; d += 5) {
    if ((d > course.TUNNEL.start - 25 && d < course.TUNNEL.end + 25) || Math.abs(d - course.BRIDGE.x) < 30) continue;
    const f = geo.frame(d);
    for (const lat of [-4.5, 0, 4.5]) {
      const err = Math.abs(field.height(f.x + f.rx * lat, f.z + f.rz * lat) - (f.y - 0.12));
      worst = Math.max(worst, err);
    }
  }
  assert.ok(worst < 0.1, `corridor error ${worst}`);
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
  assert.ok(max > 450, `highest peak ${max}`);
});

test('the drawn terrain mesh (a coarse 10 m grid) never rises above the road surface', () => {
  // mirrors how scene3d builds the inner mesh: 10 m cells, triangles (a,c,b) and (b,c,d)
  const CELL = 10;
  const x0 = geo.BOUNDS.minX - 800, z0 = geo.BOUNDS.minZ - 800;
  const cache = new Map();
  const H = (ix, iz) => { const k = ix * 100000 + iz; if (!cache.has(k)) cache.set(k, field.height(x0 + ix * CELL, z0 + iz * CELL)); return cache.get(k); };
  const meshY = (x, z) => {
    const fx = (x - x0) / CELL, fz = (z - z0) / CELL;
    const ix = Math.floor(fx), iz = Math.floor(fz), u = fx - ix, v = fz - iz;
    const a = H(ix, iz), b = H(ix + 1, iz), c = H(ix, iz + 1), d = H(ix + 1, iz + 1);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  };
  let worst = -1e9, at = '';
  for (let d = 0; d < course.LOOP; d += 3) {
    const p = geo.frame(d);
    for (const lat of [-5.8, -4.5, -2.2, 0, 2.2, 4.5, 5.8]) {
      const err = meshY(p.x + p.rx * lat, p.z + p.rz * lat) - p.y;
      if (err > worst) { worst = err; at = `d=${d} lat=${lat}`; }
    }
  }
  assert.ok(worst < -0.02, `terrain pokes ${worst.toFixed(2)} m above the road at ${at}`);
});
