// The terrain: a procedural heightfield that hugs the road, rises into mountains with distance, and
// carves a lake, a stream under the covered bridge and a cutting for the tunnel. Colours come from the
// zone, slope and altitude, so there are no texture assets to ship.

import * as THREE from 'three';
import { LOOP, SPURS, LOOP_BIOMES, BIOMES, BRIDGE, LAKE_SHAPE, onSpur, spurAt, biomeIndex, onViaduct } from '../course.js';
import { frame, place, elevEx, BOUNDS } from './geo.js';
import { makeNoise, smoothstep as sm, lerp } from './noise.js';

// ---- zone styling (sRGB, linearised below) -------------------------------------------------

const ZONE_STYLE = [
  { relief: 0.45, ground: '#46c43a' }, // meadow
  { relief: 0.85, ground: '#1f9a48' }, // forest
  { relief: 2.0, ground: '#8fa38f' }, // alpine
  { relief: 1.15, ground: '#5ccc3c' }, // descent
  { relief: 0.7, ground: '#2fc468' }, // lake
  { relief: 0.25, ground: '#6ed44e' }, // village
  { relief: 0.22, ground: '#f0c030' }, // fields
  { relief: 0.5, ground: '#a4dc42' }, // the flat road: rolling meadow
  { relief: 2.6, ground: '#7f9a78' }, // death road
  { relief: 0.55, ground: '#a4dc42' }, // the link back to the loop: rolling meadow
].map((z) => ({ relief: z.relief, ground: new THREE.Color(z.ground).toArray() }));

const ROCK = new THREE.Color('#8b8a95').toArray();
const DARK_ROCK = new THREE.Color('#4d4a5e').toArray();
const SNOW = new THREE.Color('#f3f6fb').toArray();
const SAND = new THREE.Color('#f0d894').toArray();
const BED = new THREE.Color('#2f7a86').toArray();
const GRAVEL = new THREE.Color('#8b887f').toArray();
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Zone relief and ground colour at distance s along the road, blended across zone borders. */
function zoneAt(s) {
  const spur = onSpur(s);
  const sp = spur ? SPURS[spurAt(s)] : null;
  const p = spur ? s : ((s % LOOP) + LOOP) % LOOP;
  const i = sp ? LOOP_BIOMES + sp.index : BIOMES.findIndex((b) => p >= b.start && p < b.end);
  const b = BIOMES[i];
  const B = 260;
  let relief = ZONE_STYLE[i].relief;
  let ground = ZONE_STYLE[i].ground;
  const toEnd = b.end - p;
  const fromStart = p - b.start;
  const n = LOOP_BIOMES; // the zones that make up the loop
  let other = null;
  let w = 0;
  if (toEnd < B) { other = ZONE_STYLE[sp ? biomeIndex(sp.rejoin % LOOP) : (i + 1) % n]; w = 0.5 * (1 - toEnd / B); }
  else if (fromStart < B) { other = ZONE_STYLE[sp ? biomeIndex(sp.fork) : (i - 1 + n) % n]; w = 0.5 * (1 - fromStart / B); }
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
    // road samples: the loop (a closed ring), then each detour (an open road: it runs from its fork to its rejoin)
    // A road carried over another on a viaduct is not ground: the samples under its deck are left out, which splits the
    // detour into separate roads, and the ground there follows the road beneath.
    const cs = [], ring = [];
    for (let i = 0; i < LOOP / SAMPLE; i++) { cs.push(i * SAMPLE); ring.push(0); }
    let nextRing = 1;
    for (const sp of SPURS) {
      const count = Math.ceil(sp.len / SAMPLE);
      let open = false;
      for (let i = 0; i <= count; i++) {
        const c = sp.base + Math.min(i * SAMPLE, sp.len);
        if (onViaduct(c, 10)) { open = false; continue; } // (the last 10 m of each span are abutment: ground, not ravine)
        if (!open) { nextRing++; open = true; }
        cs.push(c); ring.push(nextRing - 1);
      }
    }
    this.rings = nextRing;
    const n = cs.length;
    this.cs = Float32Array.from(cs);
    this.ring = Uint8Array.from(ring);
    this.nxt = new Int32Array(n); this.prv = new Int32Array(n);
    const first = [], last = [];
    ring.forEach((r, i) => { first[r] ??= i; last[r] = i; });
    for (let i = 0; i < n; i++) {
      const closed = ring[i] === 0, lo = first[ring[i]], hi = last[ring[i]];
      this.nxt[i] = i < hi ? i + 1 : closed ? lo : i; // an open road ends at its last sample
      this.prv[i] = i > lo ? i - 1 : closed ? hi : i;
    }
    this.sx = new Float32Array(n); this.sz = new Float32Array(n); this.sy = new Float32Array(n);
    this.relief = new Float32Array(n); this.ground = new Float32Array(n * 3);
    const f = {};
    for (let i = 0; i < n; i++) {
      frame(this.cs[i], f);
      this.sx[i] = f.x; this.sz[i] = f.z; this.sy[i] = f.y;
      const z = zoneAt(this.cs[i]);
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
    this.ringBest = new Float64Array(this.rings); this.ringY = new Float64Array(this.rings); this.ringEnd = new Uint8Array(this.rings);
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
    const nS = Math.ceil(this.n / 4);
    const sx = [], sz = [], sy = [], sr = [], sc = [];
    // a sample every 40 m is plenty under a 110 m falloff
    for (let i = 0; i < this.n; i += 4) { sx.push(this.sx[i]); sz.push(this.sz[i]); sy.push(this.sy[i]); sr.push(this.relief[i]); sc.push(i * 3); }
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
    let best = Infinity, bs = 0, by = 0, bside = 0, bring = 0;
    const ringBest = this.ringBest.fill(Infinity), ringY = this.ringY, ringEnd = this.ringEnd; // closest point on each road (the loop, then each stretch of each detour), and whether that is one of its two ends
    for (let r = 1; r <= 2; r++) {
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          const list = this.buckets.get((cx + ox) * 100003 + (cz + oz));
          if (!list) continue;
          for (let q = 0; q < list.length; q++) {
            const i = list[q];
            for (let w = 0; w < 2; w++) { // the two segments touching sample i
              const a = w === 0 ? this.prv[i] : i, b = this.nxt[a];
              const ax = this.sx[a], az = this.sz[a];
              const ex = this.sx[b] - ax, ez = this.sz[b] - az;
              const l2 = ex * ex + ez * ez || 1;
              let t = ((x - ax) * ex + (z - az) * ez) / l2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const px = ax + ex * t, pz = az + ez * t;
              const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
              const ring = this.ring[a];
              if (d2 < ringBest[ring]) { ringBest[ring] = d2; ringY[ring] = this.sy[a] + (this.sy[b] - this.sy[a]) * t; ringEnd[ring] = a === b || (t === 0 && this.prv[a] === a) || (t === 1 && this.nxt[b] === b) ? 1 : 0; }
              if (d2 < best) {
                best = d2; bring = ring;
                bs = this.cs[a] + t * (this.cs[b] - this.cs[a]);
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
    // where the two roads overlap (they share a surface there), stay under the lower of them; the bare end of a road that has not
    // started yet (or has finished) shares nothing with the ground beside it, so it is left out
    for (let k = 0; k < this.rings; k++) if (k !== bring && ringBest[k] < 10 * 10 && !ringEnd[k]) by = Math.min(by, ringY[k]);
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

/**
 * Build a terrain mesh over a rectangle.
 * `sinkInside` pushes the mesh down under another, finer mesh: a function (x, z) -> signed distance to the finer mesh's
 * area (negative inside), or a rectangle. `cover` is the same kind of function and limits this mesh to the area where it
 * is <= 0, so a fine mesh only spends vertices where it is needed.
 */
export async function buildTerrainMesh(field, { x0, z0, x1, z1, cell, sinkInside = null, cover = null, checker = 36, onProgress = null }) {
  const nx = Math.ceil((x1 - x0) / cell) + 1;
  const nz = Math.ceil((z1 - z0) / cell) + 1;
  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const aux = { ground: new Float32Array(count * 3) };
  const noise = field.noise;
  const rowsPerChunk = 24;
  const sinkDist = !sinkInside ? null : typeof sinkInside === 'function' ? sinkInside
    : (x, z) => Math.max(sinkInside.x0 - x, x - sinkInside.x1, sinkInside.z0 - z, z - sinkInside.z1); // <0 inside

  // which quads are drawn, and so which vertices are needed
  const used = cover ? new Uint8Array(count) : null;
  if (cover) {
    const inside = new Uint8Array(count);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) inside[iz * nx + ix] = cover(x0 + ix * cell, z0 + iz * cell) <= 0 ? 1 : 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iz * nx + ix;
        if (inside[a] || inside[a + 1] || inside[a + nx] || inside[a + nx + 1]) used[a] = used[a + 1] = used[a + nx] = used[a + nx + 1] = 1;
      }
    }
  }

  for (let iz = 0; iz < nz; iz++) {
    const z = z0 + iz * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * cell;
      const i = iz * nx + ix;
      pos[i * 3] = x; pos[i * 3 + 2] = z;
      uv[i * 2] = x * 0.045; uv[i * 2 + 1] = z * 0.045;
      if (used && !used[i]) continue;
      let y = field.height(x, z);
      if (sinkDist) y -= 60 * (1 - sm(-200, 0, sinkDist(x, z))); // inside the finer mesh's area, sink gently so only the fine mesh shows
      pos[i * 3 + 1] = y;
      field.grid(x, z, field.tmp);
      aux.ground[i * 3] = field.tmp.r; aux.ground[i * 3 + 1] = field.tmp.g; aux.ground[i * 3 + 2] = field.tmp.b;
    }
    if (iz % rowsPerChunk === 0) { onProgress?.(iz / nz); await new Promise((r) => setTimeout(r, 0)); }
  }

  const idx = [];
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      if (used && !(used[a] && used[b] && used[c] && used[d])) continue;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(count > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal.array;

  // colours from zone, slope and altitude
  const c3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    if (used && !used[i]) continue;
    const x = pos[i * 3], h = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const ny = Math.max(0.05, nrm[i * 3 + 1]);
    const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
    let c = [aux.ground[i * 3], aux.ground[i * 3 + 1], aux.ground[i * 3 + 2]];
    const v1 = noise.fbm(x * 0.021 + 40, z * 0.021, 3);
    const v2 = noise.fbm(x * 0.0042, z * 0.0042 + 90, 3);
    // a soft chequer, like mown stripes, gives the flat meadows scale and a sense of speed
    const chk = (Math.floor(x / checker) + Math.floor(z / checker)) & 1 ? 1 : -1;
    const bright = 1 + 0.08 * v1 + 0.06 * v2 + 0.045 * chk;
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

/**
 * Split a terrain geometry into square tiles that share its vertex data, so the renderer can skip every tile that is behind
 * the camera or too far away. (One giant mesh can only ever be drawn whole.) Each tile gets its own bounding sphere.
 */
export function tileTerrain(geo, tile = 360) {
  const pos = geo.attributes.position, index = geo.index.array;
  const tiles = new Map();
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const k = `${Math.floor(x / tile)},${Math.floor(z / tile)}`;
    let t = tiles.get(k);
    if (!t) tiles.set(k, t = []);
    t.push(a, b, c);
  }
  const out = [];
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const idx of tiles.values()) {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]); // shared, uploaded once
    g.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    box.makeEmpty();
    for (const i of idx) box.expandByPoint(v.fromBufferAttribute(pos, i));
    g.boundingBox = box.clone();
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    out.push(g);
  }
  return out;
}
