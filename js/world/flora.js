// Vegetation and roadside props. Everything is procedural: low-poly species with vertex colours,
// scattered along the course by zone, grouped into spatial chunks and drawn as instanced meshes that
// are culled by distance. Foliage sways in the wind through a small shader patch.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOOP, TOTAL, SPURS, BIOMES, LANDMARKS, TUNNEL, BRIDGE, biomeIndex, spurAt } from '../course.js';
import { frame, place } from './geo.js';
import { RIVER, LAKE, lakeR } from './terrain.js';
import { mulberry32, makeNoise, smoothstep as sm } from './noise.js';

const CHUNK = 200;
const rngNoise = makeNoise(99);

// ---- geometry helpers ---------------------------------------------------------------------------------

const C = (h) => new THREE.Color(h);
const mixC = (a, b, t) => a.clone().lerp(b, t);

/** Colour a geometry with a bottom-to-top gradient (with a little per-part tint). */
function paint(geo, bottom, top, tint = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const k = 1 + tint;
  for (let i = 0; i < p.count; i++) {
    const t = max.y > min.y ? (p.getY(i) - min.y) / (max.y - min.y) : 0;
    const c = mixC(bottom, top, t);
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

const xf = (geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx } = {}) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
};

/** An organic blob: an icosahedron with its vertices pushed around by noise. */
function blob(radius, detail, amp, seed) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + amp * rngNoise.simplex(x * 0.9 + seed, y * 0.9 + z * 0.7 + seed * 1.7);
    p.setXYZ(i, x * n, y * n * 0.92, z * n);
  }
  return g;
}

const merge = (parts) => {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingSphere();
  return g;
};

// ---- species ------------------------------------------------------------------------------------------

function makePine(snowy) {
  const parts = [];
  parts.push(paint(xf(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6), { y: 1.6 }), C('#3d2a1b'), C('#5a3d26')));
  const dark = snowy ? C('#2a5a42') : C('#1d4a2c');
  for (let i = 0; i < 5; i++) {
    const r = 3.1 * (1 - i * 0.17), h = 3.5 - i * 0.2;
    const cone = xf(new THREE.ConeGeometry(r, h, 8, 1), { y: 2.6 + i * 2.15 + h / 2, ry: i * 0.6 });
    const top = snowy ? C('#f4f8fc') : mixC(C('#3f7a45'), C('#5a9a50'), i / 5);
    parts.push(paint(cone, dark, top, (i % 2 ? 0.05 : -0.04)));
  }
  return merge(parts);
}

function makeBroadleaf(fruit) {
  const parts = [];
  parts.push(paint(xf(new THREE.CylinderGeometry(0.28, 0.46, 4.2, 6), { y: 2.1 }), C('#46301f'), C('#6b4a2e')));
  const blobs = [[0, 6.4, 0, 3.0], [-1.9, 5.2, 0.6, 2.1], [1.9, 5.4, -0.4, 2.2], [0.3, 7.6, 0.4, 2.0], [0.2, 4.9, 1.9, 1.8]];
  blobs.forEach(([x, y, z, r], i) => {
    const b = xf(blob(r, 1, 0.22, i * 3.1), { x, y, z });
    parts.push(paint(b, C('#2d6a36'), C('#86b84f'), (i % 2 ? 0.06 : -0.03)));
  });
  if (fruit) {
    for (let i = 0; i < 12; i++) {
      const a = i * 2.4, r = 2.3 + (i % 3) * 0.4;
      const f = xf(new THREE.IcosahedronGeometry(0.2, 0), { x: Math.cos(a) * r, y: 4.6 + (i % 5) * 0.7, z: Math.sin(a) * r });
      parts.push(paint(f, C(i % 3 ? '#c8352f' : '#e0b030'), C(i % 3 ? '#e04a3a' : '#f0cc50')));
    }
  }
  return merge(parts);
}

function makeBirch() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.15, 0.2, 6.2, 6);
  const tp = trunk.attributes.position;
  const tcol = new Float32Array(tp.count * 3);
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const band = Math.sin(y * 5.2) > 0.82;
    const c = band ? C('#2b2b2b') : C('#e8e6dc');
    tcol[i * 3] = c.r; tcol[i * 3 + 1] = c.g; tcol[i * 3 + 2] = c.b;
  }
  trunk.translate(0, 3.1, 0);
  trunk.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
  trunk.deleteAttribute('uv');
  parts.push(trunk.toNonIndexed());
  [[0, 6.4, 0, 1.9], [-1.0, 5.4, 0.5, 1.3], [1.1, 5.7, -0.3, 1.4]].forEach(([x, y, z, r], i) => {
    parts.push(paint(xf(blob(r, 1, 0.2, i * 5), { x, y, z }), C('#7fae52'), C('#c0dc78'), 0.02));
  });
  return merge(parts);
}

function makeBush() {
  const parts = [];
  [[0, 0.7, 0, 1.0], [-0.9, 0.55, 0.3, 0.75], [0.8, 0.6, -0.2, 0.8]].forEach(([x, y, z, r], i) => {
    parts.push(paint(xf(blob(r, 1, 0.2, i * 7 + 2), { x, y, z }), C('#2c5f31'), C('#6aa34c')));
  });
  return merge(parts);
}

function makeRock(snowy) {
  const g = xf(blob(1.3, 1, 0.38, snowy ? 4 : 9), { sx: 1.35, sy: 0.85, sz: 1.1, y: 0.45 }).toNonIndexed();
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const v = 0.36 + 0.13 * rngNoise.simplex(p.getX(i) * 2, p.getZ(i) * 2 + y);
    const c = snowy && y > 0.65 ? C('#f1f5fa') : new THREE.Color(v, v * 0.97, v * 0.92);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function makeHay() {
  const g = xf(new THREE.CylinderGeometry(0.95, 0.95, 1.3, 14), { rx: Math.PI / 2, y: 0.95 });
  return paint(g, C('#c9a345'), C('#e3c566'));
}

function makeFence() {
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(paint(xf(new THREE.BoxGeometry(0.12, 1.15, 0.12), { x: i * 1.9, y: 0.575 }), C('#6d4d33'), C('#8a6a4a')));
  for (const y of [0.45, 0.85]) parts.push(paint(xf(new THREE.BoxGeometry(3.9, 0.1, 0.06), { x: 1.9, y }), C('#7d5c40'), C('#9a7a58')));
  return merge(parts);
}

function makeLamp() {
  const parts = [];
  parts.push(paint(xf(new THREE.CylinderGeometry(0.06, 0.09, 4.4, 6), { y: 2.2 }), C('#2f343c'), C('#454c57')));
  parts.push(paint(xf(new THREE.BoxGeometry(0.9, 0.07, 0.07), { x: 0.4, y: 4.4 }), C('#2f343c'), C('#2f343c')));
  parts.push(paint(xf(new THREE.BoxGeometry(0.32, 0.12, 0.2), { x: 0.82, y: 4.34 }), C('#3a4049'), C('#3a4049')));
  return merge(parts);
}

const HOUSE_WALLS = ['#eadfc4', '#e6c3a8', '#c9d6e6', '#f1e9cf', '#d7c4aa', '#e9b8a0', '#bccbb2'];
const ROOFS = ['#9a4a3a', '#7c3f33', '#4f5560', '#8b5a3a', '#a85a40'];

/** A village house, built on the origin with its door facing +x (toward the road when rotated). */
function makeHouse(seed) {
  const r = mulberry32(seed * 977 + 13);
  const w = 6 + r() * 4, d = 5 + r() * 3, h = 3.2 + r() * 1.4;
  const wall = C(HOUSE_WALLS[Math.floor(r() * HOUSE_WALLS.length)]);
  const roof = C(ROOFS[Math.floor(r() * ROOFS.length)]);
  const parts = [];
  parts.push(paint(xf(new THREE.BoxGeometry(d, h, w), { y: h / 2 }), wall.clone().multiplyScalar(0.85), wall));
  // gable roof along z
  const rh = 1.6 + r() * 1.2;
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2 - 0.5, 0); shape.lineTo(0, rh); shape.lineTo(d / 2 + 0.5, 0); shape.lineTo(-d / 2 - 0.5, 0);
  const roofG = new THREE.ExtrudeGeometry(shape, { depth: w + 1, bevelEnabled: false });
  roofG.translate(0, 0, -(w + 1) / 2);
  parts.push(paint(xf(roofG, { y: h }), roof.clone().multiplyScalar(0.85), roof));
  // chimney, door and windows
  parts.push(paint(xf(new THREE.BoxGeometry(0.6, 1.8, 0.6), { x: -d * 0.2, y: h + rh * 0.8, z: w * 0.22 }), C('#7a5f52'), C('#8f7467')));
  parts.push(paint(xf(new THREE.BoxGeometry(0.1, 2.0, 1.0), { x: d / 2 + 0.02, y: 1.0, z: 0 }), C('#5a3b26'), C('#6e4a30')));
  const glass = r() > 0.5 ? C('#9cc7e8') : C('#f2d48b');
  for (const z of [-w * 0.3, w * 0.3]) parts.push(paint(xf(new THREE.BoxGeometry(0.1, 1.0, 1.1), { x: d / 2 + 0.02, y: h * 0.62, z }), glass, glass));
  return merge(parts);
}

// ---- grass-like cards ------------------------------------------------------------------------------------

function drawBlades(ctx, W, H, rng, { n, minH, maxH, colors, heads = null, width = 3.5 }) {
  for (let i = 0; i < n; i++) {
    const x = W / 2 + (rng() - 0.5) * (W * 0.62);
    const h = minH + rng() * (maxH - minH);
    const lean = (rng() - 0.5) * W * 0.34;
    const c = colors[Math.floor(rng() * colors.length)];
    const k = 0.75 + rng() * 0.5;
    ctx.fillStyle = `rgb(${Math.min(255, c[0] * k)},${Math.min(255, c[1] * k)},${Math.min(255, c[2] * k)})`;
    ctx.beginPath();
    ctx.moveTo(x - width, H);
    ctx.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
    ctx.quadraticCurveTo(x + lean * 0.3 + width * 0.8, H - h * 0.55, x + width, H);
    ctx.fill();
    if (heads && rng() < heads.p) {
      const hc = heads.colors[Math.floor(rng() * heads.colors.length)];
      ctx.fillStyle = `rgb(${hc[0]},${hc[1]},${hc[2]})`;
      ctx.beginPath(); ctx.ellipse(x + lean, H - h, heads.r, heads.r * (heads.tall || 1), 0, 0, 7); ctx.fill();
    }
  }
}

function cardTexture(kind) {
  const W = 128, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const rng = mulberry32(kind.length * 31 + 7);
  if (kind === 'grass') drawBlades(ctx, W, H, rng, { n: 34, minH: 46, maxH: 112, colors: [[88, 150, 58], [112, 168, 66], [70, 130, 52]] });
  if (kind === 'dry') drawBlades(ctx, W, H, rng, { n: 30, minH: 40, maxH: 100, colors: [[150, 150, 96], [176, 162, 104], [128, 134, 88]] });
  if (kind === 'flowers') drawBlades(ctx, W, H, rng, { n: 26, minH: 44, maxH: 100, colors: [[84, 148, 58], [104, 164, 66]], heads: { p: 0.9, r: 6, colors: [[255, 94, 120], [255, 214, 80], [250, 250, 250], [170, 120, 240], [255, 150, 60]] }, width: 2.2 });
  if (kind === 'wheat') drawBlades(ctx, W, H, rng, { n: 40, minH: 70, maxH: 118, colors: [[206, 172, 74], [222, 188, 88], [190, 156, 62]], heads: { p: 1, r: 4.2, tall: 2.4, colors: [[232, 198, 96], [214, 180, 78]] }, width: 2.4 });
  if (kind === 'reeds') drawBlades(ctx, W, H, rng, { n: 24, minH: 70, maxH: 124, colors: [[96, 140, 70], [120, 156, 78]], heads: { p: 0.3, r: 5, tall: 3, colors: [[108, 70, 40]] }, width: 2.6 });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function crossedCards(count = 3) {
  const geos = [];
  for (let i = 0; i < count; i++) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    g.rotateY((i * Math.PI) / count);
    geos.push(g);
  }
  return mergeGeometries(geos);
}

// ---- wind ---------------------------------------------------------------------------------------------------

export function windify(material, uTime, strength = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWind = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float h = max(position.y, 0.0);
          #ifdef USE_INSTANCING
            vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          #else
            vec4 wp = modelMatrix * vec4(position, 1.0);
          #endif
          float s = sin(uTime * 1.7 + wp.x * 0.08 + wp.z * 0.06) + 0.5 * sin(uTime * 3.1 + wp.x * 0.21 + wp.z * 0.17);
          float amt = 0.012 * uWind * h;
          transformed.x += s * amt;
          transformed.z += s * amt * 0.6;
        }`);
  };
  material.needsUpdate = true;
}

// ---- the scatter -------------------------------------------------------------------------------------------

// zone tables: density per 3 m slice per side, lateral range and weighted species
const ZONES = [
  { name: 'meadow', dens: 0.42, lat: [9, 110], sp: [['broadleaf', 6], ['bush', 3], ['rock', 1]] },
  { name: 'forest', dens: 6.0, lat: [8, 130], sp: [['pine', 74], ['broadleaf', 10], ['birch', 8], ['bush', 5], ['rock', 3]] },
  { name: 'alpine', dens: 1.4, lat: [8, 150], sp: [['pine', 35], ['rock', 55], ['bush', 10]] },
  { name: 'descent', dens: 1.7, lat: [8, 110], sp: [['orchard', 40], ['broadleaf', 24], ['pine', 14], ['bush', 16], ['rock', 6]] },
  { name: 'lake', dens: 0.9, lat: [8, 110], sp: [['birch', 34], ['broadleaf', 22], ['bush', 20], ['rock', 14], ['pine', 10]] },
  { name: 'village', dens: 0.3, lat: [9, 70], sp: [['broadleaf', 5], ['bush', 4]] },
  { name: 'fields', dens: 0.35, lat: [10, 120], sp: [['broadleaf', 6], ['bush', 2], ['rock', 1]] },
  { name: 'flats', dens: 0.28, lat: [12, 160], sp: [['broadleaf', 5], ['bush', 5], ['birch', 2], ['rock', 1]] },
  { name: 'deathroad', dens: 0.9, lat: [9, 150], sp: [['pine', 28], ['rock', 52], ['bush', 16], ['birch', 4]] },
];
const GRASS = [
  { kind: 'flowers', n: 6, lat: [6.4, 30], alt: 'grass' },
  { kind: 'grass', n: 4, lat: [6.4, 24] },
  { kind: 'dry', n: 1.2, lat: [6.4, 18] },
  { kind: 'flowers', n: 5, lat: [6.4, 28], alt: 'grass' },
  { kind: 'grass', n: 4, lat: [6.4, 26] },
  { kind: 'grass', n: 1.5, lat: [6.4, 14] },
  { kind: 'wheat', n: 11, lat: [6.4, 80] },
  { kind: 'grass', n: 1.9, lat: [6.4, 26], alt: 'flowers' },
  { kind: 'dry', n: 0.9, lat: [6.4, 14] },
];

export async function buildFlora(field, { density = 1, grassDensity = 1, onProgress = null } = {}) {
  const group = new THREE.Group();
  group.name = 'flora';
  const uTime = { value: 0 };
  const rng = mulberry32(4242);
  const chunks = new Map();
  const key = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
  const buckets = (name) => (chunks.get(name) ?? chunks.set(name, new Map()).get(name));
  const push = (kind, x, z, mat) => {
    const m = buckets(kind);
    const k = key(x, z);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(mat);
  };

  // keep clear of landmarks, the tunnel, the bridge and water
  const clear = LANDMARKS.map((lm) => { const p = place(lm.d, lm.lat); return { x: p.x, z: p.z, r: lm.kind === 'castle' ? 60 : lm.kind === 'windmill' ? 14 : lm.kind === 'lighthouse' ? 12 : lm.kind === 'cabin' ? 14 : lm.kind === 'church' ? 16 : lm.kind === 'market' ? 14 : 0 }; }).filter((c) => c.r);
  // keep the island between each detour and the loop clear around its sign, and the sides of the road at each rejoin sign
  for (const sp of SPURS) {
    const a = place(sp.fork + 200, 0), b = place(sp.base + 200, 0), e = place(sp.end - 170, 7.5);
    clear.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, r: 15 }, { x: e.x, z: e.z, r: 9 });
  }
  const riverDist = (x, z) => {
    const b = RIVER.bbox;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return 999;
    let best = 1e9;
    for (const p of RIVER.pts) best = Math.min(best, (x - p.x) ** 2 + (z - p.z) ** 2);
    return Math.sqrt(best);
  };
  const blocked = (x, z, h, margin = 0) => {
    if (lakeR(x, z) < 1.12 + margin * 0.002) return true;
    if (h < LAKE.level + 0.35 && lakeR(x, z) < 1.6) return true;
    if (riverDist(x, z) < 9 + margin) return true;
    for (const c of clear) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return true;
    return false;
  };
  const slopeAt = (x, z, h) => Math.max(Math.abs(field.height(x + 2, z) - h), Math.abs(field.height(x, z + 2) - h)) / 2;

  const q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const mat = (x, y, z, ry, s, sy = s) => new THREE.Matrix4().compose(pos.set(x, y, z), q.setFromAxisAngle(up, ry), scl.set(s, sy, s)).clone();

  let work = 0;
  const yieldNow = async (frac) => { if (++work % 450 === 0) { onProgress?.(frac); await new Promise((r) => setTimeout(r, 0)); } };

  // --- trees, rocks, bushes -------------------------------------------------
  const step = 3;
  const inGap = (s) => s >= LOOP && s < SPURS[Math.max(0, spurAt(s))].base; // the unused coordinates between two detours
  for (let s = 0; s < TOTAL; s += step) {
    if (inGap(s)) continue;
    const zi = biomeIndex(s);
    const zone = ZONES[zi];
    const total = zone.sp.reduce((a, [, w]) => a + w, 0);
    const f = frame(s);
    for (const side of [-1, 1]) {
      let n = zone.dens * density;
      if (s > TUNNEL.start - 6 && s < TUNNEL.end + 6) continue; // the tunnel hill is a built mesh
      if (Math.abs(s - BRIDGE.x) < 40) n *= 0.25;
      if (zi === 4 && side < 0) n *= 0.18; // keep the lake in view from the road
      let count = Math.floor(n) + (rng() < n - Math.floor(n) ? 1 : 0);
      while (count-- > 0) {
        const u = rng();
        const lat = zone.lat[0] + (zone.lat[1] - zone.lat[0]) * Math.pow(u, 1.8);
        const along = (rng() - 0.5) * step;
        const x = f.x + f.tx * along + f.rx * lat * side, z = f.z + f.tz * along + f.rz * lat * side;
        const near = field.nearest(x, z);
        if (near && near.dist < 7.4) continue; // quick reject; the exact clearance depends on the species below
        const h = field.height(x, z);
        if (blocked(x, z, h)) continue;
        const slope = slopeAt(x, z, h);
        let pick = rng() * total, sp = zone.sp[0][0];
        for (const [k, w] of zone.sp) { if ((pick -= w) <= 0) { sp = k; break; } }
        const snowLine = 235 + 30 * rngNoise.fbm(x * 0.004, z * 0.004, 3);
        const treeLine = 205 + 25 * rngNoise.fbm(x * 0.006 + 9, z * 0.006, 3);
        const snowy = h > snowLine + 10; // matches where the terrain itself turns white
        if ((sp === 'pine' || sp === 'broadleaf' || sp === 'orchard' || sp === 'birch') && (h > treeLine || slope > 0.85)) sp = 'rock';
        if (sp === 'rock' && slope > 1.6) continue;
        if (sp !== 'rock' && slope > 0.9) continue;
        const ry = rng() * Math.PI * 2;
        const sc = 0.72 + rng() * 0.75;
        // keep every object's whole footprint (and canopy) clear of the road and its shoulder
        const rockScale = 0.7 + rng() * 1.6;
        const size = sp === 'rock' ? rockScale : sp === 'bush' ? 0.7 + rng() * 0.8 : sc;
        const radius = { pine: 3.2, broadleaf: 4.4, orchard: 4.0, birch: 2.4, bush: 1.7, rock: 1.9 }[sp] ?? 3;
        if (near && near.dist < 6.2 + radius * size) continue;
        if (sp === 'pine') push(snowy ? 'snowpine' : 'pine', x, z, mat(x, h - 0.15, z, ry, sc, sc * (0.9 + rng() * 0.4)));
        else if (sp === 'rock') push(snowy ? 'snowrock' : 'rock', x, z, mat(x, h - 0.25, z, ry, rockScale, 0.6 + rng() * 1.1));
        else push(sp, x, z, mat(x, h - 0.15, z, ry, size));
      }
    }
    await yieldNow((s / TOTAL) * 0.35);
  }

  // --- grass, flowers, wheat, reeds ---------------------------------------------
  for (let s = 0; s < TOTAL; s += 2.5) {
    if (inGap(s)) continue;
    const zi = biomeIndex(s);
    const g = GRASS[zi];
    const f = frame(s);
    for (const side of [-1, 1]) {
      let n = g.n * grassDensity * 1.7;
      if (s > TUNNEL.start - 6 && s < TUNNEL.end + 6) continue;
      if (Math.abs(s - BRIDGE.x) < 22) n *= 0.2;
      let count = Math.floor(n) + (rng() < n - Math.floor(n) ? 1 : 0);
      while (count-- > 0) {
        const lat = g.lat[0] + (g.lat[1] - g.lat[0]) * Math.pow(rng(), 1.5);
        const along = (rng() - 0.5) * 2.5;
        const x = f.x + f.tx * along + f.rx * lat * side, z = f.z + f.tz * along + f.rz * lat * side;
        const h = field.height(x, z);
        const near = field.nearest(x, z);
        if (blocked(x, z, h, -4)) continue;
        if (h > 245) continue; // above the snow line
        let kind = g.kind;
        if (g.alt && rng() < 0.55) kind = g.alt;
        if (zi === 2 && h > 150) kind = 'dry';
        const w = kind === 'wheat' ? 1.5 + rng() * 0.7 : 1.1 + rng() * 0.9;
        // the card is w wide in every direction, so keep all of it off the tarmac and shoulder; tall wheat stays further back
        if (near && near.dist < (kind === 'wheat' ? 9 : 6.3) + w * 0.5) continue;
        push(kind, x, z, mat(x, h - 0.03, z, rng() * 6.28, w, kind === 'wheat' ? 1.2 + rng() * 0.5 : 0.55 + rng() * 0.55));
      }
    }
    await yieldNow(0.35 + (s / TOTAL) * 0.3);
  }
  // reeds right on the shoreline
  for (let i = 0; i < 520; i++) {
    const a = (i / 520) * Math.PI * 2 + rng() * 0.02;
    const rr = 1.0 + (rng() - 0.5) * 0.06;
    const la = Math.cos(a) * LAKE.ra * rr, lb = Math.sin(a) * LAKE.rb * rr;
    const x = LAKE.cx + LAKE.tx * la - LAKE.tz * lb, z = LAKE.cz + LAKE.tz * la + LAKE.tx * lb;
    const h = field.height(x, z);
    if (Math.abs(h - LAKE.level) > 1.4) continue;
    const near = field.nearest(x, z);
    if (near && near.dist < 8) continue;
    for (let k = 0; k < 3; k++) push('reeds', x, z, mat(x + (rng() - 0.5) * 3, h - 0.1, z + (rng() - 0.5) * 3, rng() * 6.28, 1.4 + rng(), 1.2 + rng() * 0.8));
  }

  // --- village houses, lamps, fences, hay -------------------------------------------
  const houseGeos = Array.from({ length: 7 }, (_, i) => makeHouse(i + 1));
  const houseChunks = new Map();
  for (let s = 8300; s < 9500; s += 17) {
    const f = frame(s);
    for (const side of [-1, 1]) {
      if (rng() < 0.18) continue;
      const lat = 12 + rng() * 5;
      const x = f.x + f.rx * lat * side, z = f.z + f.rz * lat * side;
      const near = field.nearest(x, z);
      if (near && near.dist < 9) continue;
      const h = field.height(x, z);
      if (blocked(x, z, h)) continue;
      if (slopeAt(x, z, h) > 0.35) continue;
      const g = houseGeos[Math.floor(rng() * houseGeos.length)].clone();
      // the door (+x) turns to face the road
      const face = Math.atan2(-(f.rz * side), -(f.rx * side)); // direction from house to road in xz
      xf(g, { ry: -face, x, y: h - 0.2, z });
      const k = key(x, z);
      if (!houseChunks.has(k)) houseChunks.set(k, []);
      houseChunks.get(k).push(g);
    }
    // lamp posts
    if (s % 34 < 17) for (const side of [-1, 1]) {
      const lat = 6.9;
      const x = f.x + f.rx * lat * side, z = f.z + f.rz * lat * side;
      const h = field.height(x, z);
      const face = Math.atan2(-(f.rz * side), -(f.rx * side));
      push('lamp', x, z, mat(x, h, z, -face, 1));
    }
  }
  for (const zi of [0, 3, 6, 7]) { // meadow, orchard descent, fields and Valley Road get fences and hay
    const zn = BIOMES[zi];
    for (let s = zn.start; s < zn.end; s += 15) {
      if (rng() > 0.55) continue;
      const f = frame(s);
      for (const side of [-1, 1]) {
        if (rng() < 0.4) continue;
        const lat = 10.5 + rng() * 2.5;
        const x = f.x + f.rx * lat * side, z = f.z + f.rz * lat * side;
        const near = field.nearest(x, z);
        if (near && near.dist < 9.5) continue;
        const h = field.height(x, z);
        if (blocked(x, z, h) || slopeAt(x, z, h) > 0.35) continue;
        push('fence', x, z, mat(x, h, z, -Math.atan2(f.tz, f.tx), 1));
      }
      if (zi !== 3 && rng() < 0.5) {
        const side = rng() < 0.5 ? -1 : 1;
        const lat = 14 + rng() * 40;
        const x = f.x + f.rx * lat * side, z = f.z + f.rz * lat * side;
        const h = field.height(x, z);
        if (!blocked(x, z, h) && slopeAt(x, z, h) < 0.3) push('hay', x, z, mat(x, h, z, rng() * 6.28, 0.9 + rng() * 0.4));
      }
    }
  }
  onProgress?.(0.85);
  await new Promise((r) => setTimeout(r, 0));

  // --- turn buckets into instanced meshes ---------------------------------------------------------
  const woody = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  const leafy = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
  windify(leafy, uTime, 1.0);
  const rocky = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true });
  const lampBulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff0c0').multiplyScalar(2.4), toneMapped: false });
  const species = {
    pine: { geo: makePine(false), mat: leafy, far: 780, shadow: true },
    snowpine: { geo: makePine(true), mat: leafy, far: 780, shadow: true },
    broadleaf: { geo: makeBroadleaf(false), mat: leafy, far: 760, shadow: true },
    orchard: { geo: makeBroadleaf(true), mat: leafy, far: 700, shadow: true },
    birch: { geo: makeBirch(), mat: leafy, far: 700, shadow: true },
    bush: { geo: makeBush(), mat: leafy, far: 380, shadow: false },
    rock: { geo: makeRock(false), mat: rocky, far: 700, shadow: true },
    snowrock: { geo: makeRock(true), mat: rocky, far: 760, shadow: true },
    hay: { geo: makeHay(), mat: woody, far: 420, shadow: true },
    fence: { geo: makeFence(), mat: woody, far: 300, shadow: false },
    lamp: { geo: makeLamp(), mat: woody, far: 420, shadow: true },
  };
  const cardGeo = crossedCards(3);
  const cards = {};
  for (const k of ['grass', 'dry', 'flowers', 'wheat', 'reeds']) {
    const m = new THREE.MeshStandardMaterial({ map: cardTexture(k), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: '#ffffff' });
    windify(m, uTime, k === 'wheat' || k === 'reeds' ? 2.2 : 1.6);
    cards[k] = { geo: cardGeo, mat: m, far: k === 'wheat' ? 190 : k === 'reeds' ? 260 : 120, shadow: false, card: true };
  }
  const defs = { ...species, ...cards };
  const all = []; // {mesh, cx, cz, far}
  const tint = new THREE.Color();
  for (const [kind, map] of chunks) {
    const d = defs[kind];
    for (const [k, mats] of map) {
      const [ix, iz] = k.split(',').map(Number);
      const mesh = new THREE.InstancedMesh(d.geo, d.mat, mats.length);
      mats.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        const v = 0.86 + rng() * 0.28;
        tint.setRGB(v * (0.96 + rng() * 0.08), v, v * (0.92 + rng() * 0.12));
        mesh.setColorAt(i, tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = d.shadow;
      mesh.receiveShadow = false;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox?.();
      const cx = (ix + 0.5) * CHUNK, cz = (iz + 0.5) * CHUNK;
      mesh.userData = { cx, cz, far: d.far + CHUNK * 0.75 };
      mesh.visible = false;
      group.add(mesh);
      all.push(mesh);
      if (kind === 'lamp') { // glowing bulbs ride along with the lamp posts
        const bulb = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 6), lampBulbMat, mats.length);
        const bm = new THREE.Matrix4(), off = new THREE.Matrix4().makeTranslation(0.82, 4.28, 0);
        mats.forEach((m, i) => bulb.setMatrixAt(i, bm.multiplyMatrices(m, off)));
        bulb.userData = mesh.userData;
        bulb.visible = false;
        group.add(bulb);
        all.push(bulb);
      }
    }
  }
  const houseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  for (const [k, geos] of houseChunks) {
    const merged = mergeGeometries(geos);
    const mesh = new THREE.Mesh(merged, houseMat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const [ix, iz] = k.split(',').map(Number);
    mesh.userData = { cx: (ix + 0.5) * CHUNK, cz: (iz + 0.5) * CHUNK, far: 1100 };
    mesh.visible = false;
    group.add(mesh);
    all.push(mesh);
  }

  const half = CHUNK * 0.75;
  group.userData.stats = { chunks: all.length, instances: [...chunks.values()].reduce((a, m) => a + [...m.values()].reduce((b, l) => b + l.length, 0), 0) };
  return {
    group,
    uTime,
    stats: group.userData.stats,
    /** Show only chunks near the camera. `scale` shortens draw distances on slower machines. */
    update(cam, time, scale = 1) {
      uTime.value = time;
      for (const m of all) {
        const u = m.userData;
        const dx = Math.abs(cam.x - u.cx), dz = Math.abs(cam.z - u.cz);
        const d = Math.hypot(Math.max(0, dx - CHUNK / 2), Math.max(0, dz - CHUNK / 2));
        m.visible = d < (u.far - half) * scale;
      }
    },
  };
}
