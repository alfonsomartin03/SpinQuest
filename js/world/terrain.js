// The terrain: a procedural heightfield that hugs the road, rises into mountains with distance, and
// carves a lake, a stream under the covered bridge and a cutting for the tunnel. Colours come from the
// zone, slope and altitude, so there are no texture assets to ship.

import * as THREE from 'three';
import { LOOP, BIOMES, BRIDGE, LAKE_SHAPE } from '../course.js';
import { frame, place, elevEx, BOUNDS } from './geo.js';
import { makeNoise, smoothstep as sm, lerp } from './noise.js';

// ---- zone styling (sRGB, linearised below) -------------------------------------------------

const ZONE_STYLE = [
  { relief: 0.45, ground: '#6aa84a' }, // meadow
  { relief: 0.85, ground: '#3d6e3a' }, // forest
  { relief: 2.0, ground: '#7f8a72' }, // alpine
  { relief: 1.15, ground: '#6fa04a' }, // descent
  { relief: 0.7, ground: '#5f9a48' }, // lake
  { relief: 0.25, ground: '#7aa356' }, // village
  { relief: 0.22, ground: '#c4a653' }, // fields
].map((z) => ({ relief: z.relief, ground: new THREE.Color(z.ground).toArray() }));

const ROCK = new THREE.Color('#77726a').toArray();
const DARK_ROCK = new THREE.Color('#4a4743').toArray();
const SNOW = new THREE.Color('#f3f6fb').toArray();
const SAND = new THREE.Color('#cdb98a').toArray();
const BED = new THREE.Color('#4d6a60').toArray();
const GRAVEL = new THREE.Color('#8b887f').toArray();
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Zone relief and ground colour at distance s along the road, blended across zone borders. */
function zoneAt(s) {
  const p = ((s % LOOP) + LOOP) % LOOP;
  const i = BIOMES.findIndex((b) => p >= b.start && p < b.end);
  const b = BIOMES[i];
  const B = 260;
  let relief = ZONE_STYLE[i].relief;
  let ground = ZONE_STYLE[i].ground;
  const toEnd = b.end - p;
  const fromStart = p - b.start;
  const n = BIOMES.length;
  let other = null;
  let w = 0;
  if (toEnd < B) { other = ZONE_STYLE[(i + 1) % n]; w = 0.5 * (1 - toEnd / B); }
  else if (fromStart < B) { other = ZONE_STYLE[(i - 1 + n) % n]; w = 0.5 * (1 - fromStart / B); }
  if (other) { relief = lerp(relief, other.relief, w); ground = mixc(ground, other.ground, w); }
  return { relief, ground, biome: i };
}

// ---- features ---------------------------------------------------------------------------------

const LAKE_RA = LAKE_SHAPE.ra;
const LAKE_RB = LAKE_SHAPE.rb;
const lakeFrame = frame(LAKE_SHAPE.d);
/** Water sits just below the lowest road beside the lake, so the road is never under water. */
function lakeLevel() {
  let low = Infinity;
  for (let d = LAKE_SHAPE.d - LAKE_SHAPE.ra * 1.15; d <= LAKE_SHAPE.d + LAKE_SHAPE.ra * 1.15; d += 5) low = Math.min(low, elevEx(d));
  return low - 1.4;
}

export const LAKE = (() => {
  const c = place(LAKE_SHAPE.d, -LAKE_SHAPE.offset);
  return { cx: c.x, cz: c.z, tx: lakeFrame.tx, tz: lakeFrame.tz, ra: LAKE_RA, rb: LAKE_RB, level: lakeLevel() };
})();

/** Normalised radius inside the lake ellipse (1 = shoreline). */
export function lakeR(x, z) {
  const dx = x - LAKE.cx, dz = z - LAKE.cz;
  const a = dx * LAKE.tx + dz * LAKE.tz;
  const b = -dx * LAKE.tz + dz * LAKE.tx;
  return Math.hypot(a / LAKE.ra, b / LAKE.rb);
}

const bridgeFrame = frame(BRIDGE.x);
const BRIDGE_WATER = bridgeFrame.y - 4.4;
export const RIVER = (() => {
  const pb = place(BRIDGE.x, 0);
  const R = { x: bridgeFrame.rx, z: bridgeFrame.rz };
  const T = { x: bridgeFrame.tx, z: bridgeFrame.tz };
  // from the hillside on the right, under the bridge, then down to the lake shore
  const dx = LAKE.cx - pb.x, dz = LAKE.cz - pb.z;
  const dl = Math.hypot(dx, dz);
  const shore = { x: LAKE.cx - (dx / dl) * LAKE.rb * 0.98, z: LAKE.cz - (dz / dl) * LAKE.rb * 0.98 };
  const ctrl = [
    [pb.x + R.x * 420 + T.x * 90, pb.z + R.z * 420 + T.z * 90],
    [pb.x + R.x * 250 - T.x * 40, pb.z + R.z * 250 - T.z * 40],
    [pb.x + R.x * 130 + T.x * 30, pb.z + R.z * 130 + T.z * 30],
    [pb.x + R.x * 70, pb.z + R.z * 70],
    [pb.x, pb.z],
    [pb.x - R.x * 80 + T.x * 25, pb.z - R.z * 80 + T.z * 25],
    [(pb.x + shore.x) / 2 + T.x * 30, (pb.z + shore.z) / 2 + T.z * 30],
    [shore.x, shore.z],
  ];
  const curve = new THREE.CatmullRomCurve3(ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const pts = curve.getSpacedPoints(Math.round(curve.getLength() / 6));
  const bridgeIdx = pts.reduce((best, p, i) => (Math.hypot(p.x - pb.x, p.z - pb.z) < Math.hypot(pts[best].x - pb.x, pts[best].z - pb.z) ? i : best), 0);
  // water level: falls from the hills to the lake (about 1.4% upstream of the bridge)
  const level = pts.map((_, i) => {
    if (i <= bridgeIdx) return BRIDGE_WATER + (bridgeIdx - i) * 6 * 0.014;
    return lerp(BRIDGE_WATER, LAKE.level, (i - bridgeIdx) / (pts.length - 1 - bridgeIdx));
  });
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  return { pts, level, bridgeIdx, bbox: { minX: minX - 60, maxX: maxX + 60, minZ: minZ - 60, maxZ: maxZ + 60 } };
})();

const bridgeProfile = (s) => 1 - sm(8.8, 10.4, Math.abs(s - BRIDGE.x)); // the stream bed is only under the deck
const SHELF = 21; // flat shelf beside the road (m)
const SHELF_SLOPE = 0.9; // how fast ground may rise beyond the shelf

// ---- the field --------------------------------------------------------------------------------------

const SAMPLE = 10; // road samples for distance queries (m)
const CELL = 80; // hash-grid cell (m)

class Grid {
  constructor(x0, z0, cell, nx, nz) {
    Object.assign(this, { x0, z0, cell, nx, nz });
    const n = nx * nz;
    this.dist = new Float32Array(n);
    this.h = new Float32Array(n);
    this.relief = new Float32Array(n);
    this.col = new Float32Array(n * 3);
  }

  sample(x, z, out) {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.cell));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - this.z0) / this.cell));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const i00 = iz * this.nx + ix, i10 = i00 + 1, i01 = i00 + this.nx, i11 = i01 + 1;
    const b = (arr, k = 1, o = 0) => {
      const a = arr[i00 * k + o] * (1 - tx) + arr[i10 * k + o] * tx;
      const c = arr[i01 * k + o] * (1 - tx) + arr[i11 * k + o] * tx;
      return a * (1 - tz) + c * tz;
    };
    out.dist = b(this.dist);
    out.h = b(this.h);
    out.relief = b(this.relief);
    out.r = b(this.col, 3, 0); out.g = b(this.col, 3, 1); out.b = b(this.col, 3, 2);
    return out;
  }
}

export class TerrainField {
  constructor() {
    this.noise = makeNoise(20260);
    // road samples
    const n = LOOP / SAMPLE;
    this.sx = new Float32Array(n); this.sz = new Float32Array(n); this.sy = new Float32Array(n);
    this.relief = new Float32Array(n); this.ground = new Float32Array(n * 3);
    const f = {};
    for (let i = 0; i < n; i++) {
      frame(i * SAMPLE, f);
      this.sx[i] = f.x; this.sz[i] = f.z; this.sy[i] = f.y;
      const z = zoneAt(i * SAMPLE);
      this.relief[i] = z.relief;
      this.ground[i * 3] = z.ground[0]; this.ground[i * 3 + 1] = z.ground[1]; this.ground[i * 3 + 2] = z.ground[2];
    }
    this.n = n;
    // hash grid of segment starts
    this.buckets = new Map();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(this.sx[i] / CELL) * 100003 + Math.floor(this.sz[i] / CELL);
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(i);
    }
    this.tmp = {};
    this.near = { dist: 0, s: 0, y: 0, side: 0 };
  }

  /** Build the coarse grids (distance, baseline height, relief, ground colour). */
  buildGrids(onProgress) {
    const m = 800;
    const inner = { x0: BOUNDS.minX - m, z0: BOUNDS.minZ - m, x1: BOUNDS.maxX + m, z1: BOUNDS.maxZ + m };
    this.inner = inner;
    const mk = (x0, z0, x1, z1, cell) => new Grid(x0, z0, cell, Math.ceil((x1 - x0) / cell) + 2, Math.ceil((z1 - z0) / cell) + 2);
    this.g1 = mk(inner.x0, inner.z0, inner.x1, inner.z1, 20);
    this.g2 = new Grid(-7000, -9000, 100, 162, 162); // the whole surroundings, coarsely
    for (const g of [this.g1, this.g2]) this.#fillGrid(g, onProgress);
  }

  #fillGrid(g) {
    const sigma2 = 110 * 110;
    const nS = this.n / 2;
    const sx = [], sz = [], sy = [], sr = [], sc = [];
    for (let i = 0; i < this.n; i += 2) { sx.push(this.sx[i]); sz.push(this.sz[i]); sy.push(this.sy[i]); sr.push(this.relief[i]); sc.push(i * 3); }
    for (let iz = 0; iz < g.nz; iz++) {
      const z = g.z0 + iz * g.cell;
      for (let ix = 0; ix < g.nx; ix++) {
        const x = g.x0 + ix * g.cell;
        let dmin2 = Infinity;
        for (let k = 0; k < nS; k++) { const dx = x - sx[k], dz = z - sz[k]; const d2 = dx * dx + dz * dz; if (d2 < dmin2) dmin2 = d2; }
        let W = 0, H = 0, Rl = 0, cr = 0, cg = 0, cb = 0;
        for (let k = 0; k < nS; k++) {
          const dx = x - sx[k], dz = z - sz[k];
          const e = (dx * dx + dz * dz - dmin2) / sigma2;
          if (e > 9) continue;
          const w = Math.exp(-e);
          W += w; H += w * sy[k]; Rl += w * sr[k];
          cr += w * this.ground[sc[k]]; cg += w * this.ground[sc[k] + 1]; cb += w * this.ground[sc[k] + 2];
        }
        const idx = iz * g.nx + ix;
        g.dist[idx] = Math.sqrt(dmin2);
        g.h[idx] = H / W; g.relief[idx] = Rl / W;
        g.col[idx * 3] = cr / W; g.col[idx * 3 + 1] = cg / W; g.col[idx * 3 + 2] = cb / W;
      }
    }
  }

  /** Exact distance to the road within ~170 m: {dist, s, y, side}. Null when further away. */
  nearest(x, z) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = Infinity, bs = 0, by = 0, bside = 0;
    const SEGS = this.n;
    for (let r = 1; r <= 2; r++) {
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          const list = this.buckets.get((cx + ox) * 100003 + (cz + oz));
          if (!list) continue;
          for (let q = 0; q < list.length; q++) {
            const i = list[q];
            for (let w = 0; w < 2; w++) { // the two segments touching sample i
              const a = (i - 1 + w + SEGS) % SEGS, b = (a + 1) % SEGS;
              const ax = this.sx[a], az = this.sz[a];
              const ex = this.sx[b] - ax, ez = this.sz[b] - az;
              const l2 = ex * ex + ez * ez || 1;
              let t = ((x - ax) * ex + (z - az) * ez) / l2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const px = ax + ex * t, pz = az + ez * t;
              const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
              if (d2 < best) {
                best = d2;
                bs = a * SAMPLE + t * SAMPLE;
                by = this.sy[a] + (this.sy[b] - this.sy[a]) * t;
                bside = (x - px) * -ez + (z - pz) * ex; // >0 means left of travel in xz
              }
            }
          }
        }
      }
      if (best < (r * CELL * 0.9) ** 2) break;
    }
    if (best === Infinity) return null;
    const o = this.near;
    o.dist = Math.sqrt(best); o.s = bs; o.y = by; o.side = bside;
    return o;
  }

  grid(x, z, out) {
    const i = this.inner;
    return (x > i.x0 && x < i.x1 && z > i.z0 && z < i.z1 ? this.g1 : this.g2).sample(x, z, out);
  }

  /** Level building pads: {x, z, r, blend}. Terrain is flattened to its own centre height within r. */
  setPads(list) {
    this.pads = [];
    for (const p of list) this.pads.push({ ...p, h: this.heightRaw(p.x, p.z) + (p.lift || 0) });
  }

  height(x, z) {
    let h = this.heightRaw(x, z);
    if (this.pads) {
      for (const p of this.pads) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.r + p.blend) h = lerp(p.h, h, sm(p.r, p.r + p.blend, d));
      }
    }
    return h;
  }

  /** Terrain height at world (x, z), before building pads. */
  heightRaw(x, z) {
    const g = this.grid(x, z, this.tmp);
    const near = this.nearest(x, z);
    const d = near && near.dist < 170 ? near.dist : g.dist;
    const nz = this.noise;
    const hills = 4.5 * sm(10, 70, d) * nz.fbm(x * 0.010, z * 0.010, 3);
    const rolling = (2 + 16 * g.relief) * sm(40, 500, d) * nz.fbm(x * 0.0045, z * 0.0045, 4);
    const mtn = g.relief * 230 * Math.pow(sm(140, 1500, d), 1.15) * (0.3 + 0.7 * nz.ridged(x * 0.0009, z * 0.0009, 3));
    let h = g.h + hills + rolling + mtn;
    h = this.#river(x, z, h);
    h = this.#lake(x, z, h);
    if (near && near.dist < 90) {
      const bed = BRIDGE_WATER - 1.3;
      const corr = lerp(near.y, bed, bridgeProfile(near.s)) - 0.14; // just under the road surface
      const blended = lerp(corr, h, sm(5.5, 14, near.dist)); // natural ground fades in from the road edge
      // The mesh is a coarse grid, so a triangle that spans the road reaches vertices up to ~20 m away. Keep a flat
      // shelf at road level that wide (ground may fall away from it, never rise above it) and climb gently after it.
      h = Math.min(blended, corr + SHELF_SLOPE * Math.max(0, near.dist - SHELF));
    }
    return h;
  }

  #river(x, z, h) {
    const b = RIVER.bbox;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return h;
    let best = Infinity, bi = 0;
    const p = RIVER.pts;
    for (let i = 0; i < p.length; i++) { const d2 = (x - p[i].x) ** 2 + (z - p[i].z) ** 2; if (d2 < best) { best = d2; bi = i; } }
    const d = Math.sqrt(best);
    if (d > 34) return h;
    const bedH = RIVER.level[bi] - 1.4;
    return lerp(bedH, h, sm(5, 30, d)); // a continuous valley that always matches the water level
  }

  #lake(x, z, h) {
    const r = lakeR(x, z);
    if (r > 1.28) return h;
    const t = 1 - sm(0.84, 1.24, r);
    const bed = LAKE.level - 0.7 - 7 * (1 - Math.min(r, 1) ** 2);
    return lerp(h, Math.min(h, bed), t); // the shoreline wobble comes from the surrounding land height
  }
}

// ---- mesh building ----------------------------------------------------------------------------------

/** Tiling greyscale detail texture so large areas never look flat. */
export function makeDetailTexture(noise) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // wrap-around noise: sample on a torus so the tile repeats seamlessly
      const a = (x / S) * Math.PI * 2, b = (y / S) * Math.PI * 2;
      const k = 1.6;
      const n = noise.fbm(Math.cos(a) * k + 10, Math.sin(a) * k + Math.cos(b) * k, 4) * 0.6 + noise.simplex(Math.sin(b) * 4, Math.cos(a) * 4) * 0.2;
      const v = Math.max(0, Math.min(255, 210 + n * 70));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Build a terrain mesh over a rectangle. `sinkInside` (a rect) pushes the mesh down under another, finer mesh. */
export async function buildTerrainMesh(field, { x0, z0, x1, z1, cell, sinkInside = null, onProgress = null }) {
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const aux = { ground: new Float32Array(count * 3) };
  const noise = field.noise;
  const rowsPerChunk = 24;

  for (let iz = 0; iz < nz; iz++) {
    const z = z0 + iz * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * cell;
      const i = iz * nx + ix;
      pos[i * 3] = x; pos[i * 3 + 2] = z;
      let y = field.height(x, z);
      if (sinkInside) { // inside the finer mesh's area, sink gently so only the fine mesh shows
        const d = Math.max(sinkInside.x0 - x, x - sinkInside.x1, sinkInside.z0 - z, z - sinkInside.z1); // <0 inside
        y -= 60 * (1 - sm(-200, 0, d));
      }
      pos[i * 3 + 1] = y;
      field.grid(x, z, field.tmp);
      aux.ground[i * 3] = field.tmp.r; aux.ground[i * 3 + 1] = field.tmp.g; aux.ground[i * 3 + 2] = field.tmp.b;
      uv[i * 2] = x * 0.045; uv[i * 2 + 1] = z * 0.045;
    }
    if (iz % rowsPerChunk === 0) { onProgress?.(iz / nz); await new Promise((r) => setTimeout(r, 0)); }
  }

  const idx = [];
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx.length > 65535 * 3 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal.array;

  // colours from zone, slope and altitude
  const c3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], h = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const ny = Math.max(0.05, nrm[i * 3 + 1]);
    const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
    let c = [aux.ground[i * 3], aux.ground[i * 3 + 1], aux.ground[i * 3 + 2]];
    const v1 = noise.fbm(x * 0.021 + 40, z * 0.021, 3);
    const v2 = noise.fbm(x * 0.0042, z * 0.0042 + 90, 3);
    const bright = 1 + 0.16 * v1 + 0.1 * v2;
    c = [c[0] * bright, c[1] * bright * (1 + 0.04 * v2), c[2] * bright * (1 - 0.05 * v2)];
    // exposed rock on steep ground and high up
    const rockAmt = Math.max(sm(0.5, 1.05, slope), sm(190, 330, h + v2 * 30) * 0.55);
    c = mixc(c, mixc(ROCK, DARK_ROCK, sm(0.9, 1.6, slope) * 0.8), rockAmt);
    // lake bed, beach and stream banks
    const r = lakeR(x, z);
    if (r < 1.3) {
      c = mixc(c, SAND, sm(LAKE.level + 1.8, LAKE.level + 0.3, h) * 0.9);
      c = mixc(c, BED, sm(LAKE.level + 0.1, LAKE.level - 1.2, h));
    }
    // snow above the snow line, thinner on steep faces
    const snowLine = 235 + 30 * noise.fbm(x * 0.004, z * 0.004, 3);
    const snow = sm(snowLine, snowLine + 45, h) * (1 - 0.85 * sm(0.9, 1.5, slope));
    c = mixc(c, SNOW, snow);
    c3[0] = c[0]; c3[1] = c[1]; c3[2] = c[2];
    col[i * 3] = c3[0]; col[i * 3 + 1] = c3[1]; col[i * 3 + 2] = c3[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
