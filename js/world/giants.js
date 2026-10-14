// Giant, slightly impossible scenery: towering mushrooms, crystal gardens, candy spires, balloon trees, flowers the size of
// houses, stone arches, floating islands, gyroscope rings and ringed planets. Each is one small merged mesh with vertex colours
// (a few hundred triangles), built at its real size in metres with its base on y = 0, so flora.js can scatter them as
// instances with a plain scale. Floating things have their height above the ground baked in.

import * as THREE from 'three';
import { C, mixC, paint, paintBy, xf, blob, roughen, merge } from './geomkit.js';
import { mulberry32 } from './noise.js';

const lathe = (pts, seg = 10) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
const curve = (pts) => new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
const tube = (pts, r, seg = 8, radial = 5) => new THREE.TubeGeometry(curve(pts), seg, r, radial);
const at = (arr, n) => arr[((Math.floor(n) % arr.length) + arr.length) % arr.length]; // a non-negative modulo pick
const ball = (r, o = {}, w = 8, h = 6) => xf(new THREE.SphereGeometry(1, w, h), { sx: r, sy: r, sz: r, ...o });

// ---- mushrooms --------------------------------------------------------------------------------------------------------

const MUSHROOMS = [
  { cap: ['#c2203a', '#ff6f7a'], spot: '#fff6e0', stem: ['#d9c7a8', '#f6ecd6'], gill: '#f7e3bd' },
  { cap: ['#5a2bd6', '#c58bff'], spot: '#8ffbff', stem: ['#c9bff0', '#efe9ff'], gill: '#e9defc' },
  { cap: ['#f0780a', '#ffd36a'], spot: '#ffffff', stem: ['#e8d2b2', '#fff3dc'], gill: '#fff1cf' },
];

function mushroomOne(c, seed, fine = 1) {
  const r = mulberry32(seed);
  const parts = [];
  parts.push(paint(lathe([[4.2, 0], [2.9, 4], [2.5, 10], [3.7, 19.6]], 8), C(c.stem[0]), C(c.stem[1])));
  parts.push(paint(xf(new THREE.SphereGeometry(1, fine ? 12 : 8, fine ? 6 : 4, 0, Math.PI * 2, 0, Math.PI * 0.5), { sx: 16, sy: 10, sz: 16, y: 19 }), C(c.cap[0]), C(c.cap[1])));
  parts.push(paint(lathe([[0.01, 18.7], [16, 19.2]], fine ? 12 : 8), C(c.gill), C(c.gill)));
  for (let i = 0; i < (fine ? 6 : 3); i++) {
    const th = r() * Math.PI * 2, ph = 0.25 + r() * 0.85; // angle round the cap, and down from the crown
    const s = 1.5 + r() * 1.6;
    parts.push(paint(ball(s, { x: Math.sin(ph) * Math.cos(th) * 15.6, y: 19 + Math.cos(ph) * 9.7, z: Math.sin(ph) * Math.sin(th) * 15.6, sy: s * 0.55 }, 5, 3), C(c.spot), C(c.spot)));
  }
  return parts;
}

export function makeMushroom(v = 0) {
  const c = MUSHROOMS[v % MUSHROOMS.length];
  const parts = mushroomOne(c, 11 + v);
  // a small one beside it
  for (const p of mushroomOne(c, 31 + v, 0)) parts.push(xf(p, { x: 17, z: 9, sx: 0.4, sy: 0.4, sz: 0.4 }));
  return merge(parts);
}

// ---- crystals --------------------------------------------------------------------------------------------------------

const CRYSTALS = [['#5a1fc0', '#ff9be8'], ['#0b6fd0', '#a8fff2'], ['#e0601a', '#ffe08a']];

export function makeCrystals(v = 0) {
  const [lo, hi] = CRYSTALS[v % CRYSTALS.length];
  const r = mulberry32(77 + v);
  const parts = [];
  const one = (h, rad, x, z, tilt, yaw) => {
    const body = new THREE.CylinderGeometry(rad * 0.9, rad, h * 0.62, 6, 1, true);
    xf(body, { y: h * 0.31 });
    const tip = new THREE.ConeGeometry(rad * 0.9, h * 0.38, 6);
    xf(tip, { y: h * 0.62 + h * 0.19 });
    const g = paint(merge([body, tip]), C(lo), C(hi));
    xf(g, { rx: tilt * Math.cos(yaw), rz: -tilt * Math.sin(yaw), x, z, ry: r() * 3 });
    parts.push(g);
  };
  one(58, 5.2, 0, 0, 0.04, 0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.5, d = 6 + r() * 9;
    one(18 + r() * 28, 2.2 + r() * 2.6, Math.cos(a) * d, Math.sin(a) * d, 0.18 + r() * 0.3, a);
  }
  return merge(parts);
}

// ---- stone arch ------------------------------------------------------------------------------------------------------

const STRATA = [['#b8482e', '#e08a56', '#f6c08a'], ['#6b48b0', '#a77bd8', '#e0c4ff']];

export function makeArch(v = 0) {
  const pal = STRATA[v % STRATA.length].map(C);
  const R = 22, T = 5.6, H = 9;
  const span = roughen(new THREE.TorusGeometry(R, T, 6, 16, Math.PI), 0.7, 0.14, 3);
  xf(span, { y: H });
  const parts = [paintBy(span, (x, y) => at(pal, Math.max(0, y) / 4.2).clone().multiplyScalar(0.95 + 0.1 * Math.sin(x * 0.4)))];
  for (const s of [-1, 1]) {
    const leg = roughen(new THREE.CylinderGeometry(T * 1.02, T * 1.25, H + 2, 8, 2), 0.5, 0.16, s + 5);
    parts.push(paintBy(xf(leg, { x: s * R, y: (H + 2) / 2 - 1 }), (x, y) => at(pal, (y + 1) / 3.6)));
    parts.push(paint(blob(4.5, 1, 0.25, s * 9), pal[0], pal[1]));
    xf(parts[parts.length - 1], { x: s * (R + 9), y: 1.5, z: 3 });
  }
  return merge(parts);
}

// ---- floating island -------------------------------------------------------------------------------------------------

export function makeIsland(v = 0, lift = 62) {
  const parts = [];
  const top = new THREE.CylinderGeometry(20, 17, 4, 12, 1);
  parts.push(paintBy(roughen(top, 0.8, 0.1, v), (x, y, z) => (y > 0 ? mixC(C('#58d84a'), C('#b6f568'), Math.min(1, Math.hypot(x, z) / 20)) : C('#8a5a3a'))));
  parts.push(paint(xf(roughen(new THREE.ConeGeometry(17, 30, 9, 3), 1.2, 0.12, v + 4), { y: -17, rx: Math.PI }), C('#4a3a6a'), C('#a898c8')));
  for (const [x, y, z, s] of [[-6, -36, 4, 3.2], [7, -44, -3, 2.2], [1, -52, 7, 1.5]]) parts.push(xf(paint(blob(s, 1, 0.25, x + v), C('#5a4a7a'), C('#a898c8')), { x, y, z }));
  if (v === 0) { // a tree and a boulder up top
    parts.push(paint(xf(new THREE.CylinderGeometry(0.7, 1.0, 5, 6, 1, true), { x: -6, y: 4.5, z: 2 }), C('#6a4426'), C('#9a6a3a')));
    parts.push(paint(xf(new THREE.IcosahedronGeometry(6, 1), { x: -6, y: 11, z: 2, sy: 1.1 }), C('#19b042'), C('#a6f55a')));
  } else { // a little crystal spire
    parts.push(paint(xf(new THREE.ConeGeometry(3, 14, 5), { x: 5, y: 9, z: -3 }), C('#0b6fd0'), C('#a8fff2')));
    parts.push(paint(xf(new THREE.ConeGeometry(2, 8, 5), { x: 9, y: 6, z: 3 }), C('#5a1fc0'), C('#ff9be8')));
  }
  return xf(merge(parts), { y: lift + 40 });
}

// ---- gyroscope ring --------------------------------------------------------------------------------------------------

export function makeRing(v = 0) {
  const R = 22;
  const lo = v ? '#2ee6ff' : '#ff4f9a', hi = v ? '#7a5bff' : '#ffa05a';
  const outer = paint(xf(new THREE.TorusGeometry(R, 2.4, 6, 26), { y: R + 3 }), C(lo), C(hi));
  const mid = paint(xf(new THREE.TorusGeometry(R * 0.7, 1.3, 5, 22), { y: R + 3, ry: Math.PI / 2 }), C('#ffe45e'), C('#fff6b0'));
  const core = paint(ball(5, { y: R + 3 }, 10, 7), C('#fff27a'), C('#ffffff'));
  const base = paint(lathe([[7, 0], [5, 1.6], [3, 3]], 8), C('#3a3560'), C('#6a62a8'));
  return merge([outer, mid, core, base]);
}

/**
 * A gate the road runs through: a great ring standing across it, its lower half buried, with a glowing inner ring and beads. The
 * ring's plane is the local y-z plane (its axis is the road's direction when placed with `yawFrom: 'along'`).
 */
export function makePortal() {
  const R = 26;
  const outer = paint(xf(new THREE.TorusGeometry(R, 2.9, 6, 30), { y: 1 }), C('#ff4f9a'), C('#ffb05a'));
  const inner = paint(xf(new THREE.TorusGeometry(R - 3.6, 0.8, 4, 30), { y: 1 }), C('#2ee6ff'), C('#b8fbff'));
  const parts = [outer, inner];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    if (Math.sin(a) < -0.1) continue; // the beads that would be underground
    parts.push(paint(ball(1.5, { x: Math.cos(a) * (R + 4.2), y: 1 + Math.sin(a) * (R + 4.2) }, 6, 4), C('#fff27a'), C('#ffffff')));
  }
  return xf(merge(parts), { ry: Math.PI / 2 });
}

// ---- twisted spire ---------------------------------------------------------------------------------------------------

const CANDY = [['#ff7fae', '#fff0f6'], ['#20cdb8', '#effff9']];

export function makeSpire(v = 0) {
  const [c1, c2] = CANDY[v % CANDY.length].map(C);
  const H = 110, rings = 22;
  const pts = [];
  for (let i = 0; i <= rings; i++) { const y = (i / rings) * H; pts.push([14 * Math.pow(1 - i / rings, 0.8) + 0.5 + (i === 0 ? 2.5 : 0), y]); }
  const g = lathe(pts, 15);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const th = Math.atan2(z, x), r = Math.hypot(x, z) * (1 + 0.26 * Math.cos(5 * th + y * 0.07));
    const a = th + y * 0.05; // the twist
    p.setXYZ(i, Math.cos(a) * r, y, Math.sin(a) * r);
  }
  g.computeVertexNormals();
  return paintBy(g, (x, y) => (Math.floor(y / 9) % 2 ? c1 : c2));
}

// ---- balloon tree ----------------------------------------------------------------------------------------------------

const BALLOONS = [['#ff8fcf', '#ffd1ec', '#ff5fae'], ['#7df0cf', '#d6fff1', '#2fd1a8'], ['#ffd86a', '#fff2b8', '#ffb43a']];

export function makeBalloonTree(v = 0) {
  const pal = BALLOONS[v % BALLOONS.length].map(C);
  const trunk = paint(tube([[0, 0, 0], [2.5, 10, 1], [-1.5, 22, 0], [1, 33, -1]], 1.5, 8, 5), C('#7a5a46'), C('#d9c3a5'));
  const can = xf(new THREE.IcosahedronGeometry(15, 2), { x: 1, y: 44, z: -1, sy: 0.92 });
  const canopy = paintBy(can, (x, y, z) => at(pal, (y + x * 0.35 + 30) / 4.6));
  const small = paint(xf(new THREE.IcosahedronGeometry(6, 1), { x: -13, y: 30, z: 6 }), pal[0], pal[1]);
  return merge([trunk, canopy, small]);
}

// ---- giant flower ----------------------------------------------------------------------------------------------------

const FLOWERS = [{ petal: ['#ff4f93', '#ffa0c8'], core: '#ffd23f' }, { petal: ['#ffe45e', '#fffbd0'], core: '#ff7a2a' }, { petal: ['#7a5bff', '#cdb8ff'], core: '#ffffff' }];

export function makeFlower(v = 0) {
  const f = FLOWERS[v % FLOWERS.length];
  const parts = [paint(tube([[0, 0, 0], [-1.2, 12, 0.6], [1.5, 24, -0.4], [0, 35, 0]], 1.0, 8, 5), C('#1f9a48'), C('#6ae05a'))];
  for (const [y, s, a] of [[9, 1, 0.4], [18, -1, 2.4]]) parts.push(paint(ball(1, { x: s * 4.5, y, sx: 5.5, sy: 0.9, sz: 2.2, rz: s * 0.4, ry: a }, 6, 4), C('#12a83f'), C('#6af05a')));
  const head = [paint(ball(4.4, { sy: 2.4 }, 9, 6), C(f.core), C(f.core))];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    head.push(paint(ball(1, { x: Math.cos(a) * 9, z: Math.sin(a) * 9, y: 0.5, sx: 7.5, sy: 1.2, sz: 3, ry: -a, rz: 0.22 }, 6, 4), C(f.petal[0]), C(f.petal[1])));
  }
  const h = merge(head);
  xf(h, { y: 36.5, rz: -0.35 });
  parts.push(h);
  return merge(parts);
}

// ---- mesa / hoodoo ---------------------------------------------------------------------------------------------------

const MESAS = [['#b04a30', '#e8895a', '#f6c590', '#d46a44'], ['#3b5fb0', '#7a8fe0', '#c4d0ff', '#5a74c8']];

export function makeMesa(v = 0) {
  const pal = MESAS[v % MESAS.length].map(C);
  const layers = [[15, 7], [11.5, 6], [14, 6], [9, 9], [11, 5]];
  const parts = [];
  let y = 0;
  layers.forEach(([r, h], i) => {
    const g = roughen(new THREE.CylinderGeometry(r * 0.92, r, h, 8, 1, true), 0.6, 0.14, i * 3 + v);
    parts.push(paintBy(xf(g, { y: y + h / 2 }), () => pal[i % 4]));
    y += h;
  });
  const topR = layers[layers.length - 1][0] * 0.92;
  parts.push(paint(xf(new THREE.CylinderGeometry(topR, topR, 1.4, 8), { y: y + 0.7 }), C('#58d84a'), C('#b6f568')));
  parts.push(paint(xf(new THREE.IcosahedronGeometry(4, 1), { x: 2, y: y + 5, z: -1 }), C('#19b042'), C('#a6f55a')));
  return merge(parts);
}

// ---- ringed planet ---------------------------------------------------------------------------------------------------

const PLANETS = [['#ff9a4a', '#ffd9a0', '#c4572a'], ['#6a5bff', '#cfc8ff', '#2fd1e8']];

export function makePlanet(v = 0, lift = 70) {
  const pal = PLANETS[v % PLANETS.length].map(C);
  const sphere = paintBy(new THREE.IcosahedronGeometry(13, 2), (x, y) => at(pal, (y + 13) / 4.3));
  const ring = paint(xf(new THREE.TorusGeometry(21, 2.6, 4, 30), { sy: 1, rx: Math.PI / 2 + 0.35, rz: 0.2, sz: 0.16 }), C('#ffe08a'), C('#fff3c0'));
  return xf(merge([sphere, ring]), { y: lift + 20 });
}

// ---- the catalogue -----------------------------------------------------------------------------------------------------

/**
 * Every giant kind: its geometry maker, how wide its footprint is (m, at scale 1), how far away it can be seen, whether it hovers
 * (hovering ones may stand over water and over the sides of the road) and the scale range it is planted at.
 */
export const GIANT_KINDS = {
  mushroom0: { make: () => makeMushroom(0), r: 24, far: 1500, scale: [0.8, 1.7] },
  mushroom1: { make: () => makeMushroom(1), r: 24, far: 1500, scale: [0.8, 1.7] },
  mushroom2: { make: () => makeMushroom(2), r: 24, far: 1500, scale: [0.8, 1.7] },
  crystal0: { make: () => makeCrystals(0), r: 16, far: 1700, scale: [0.9, 2.0] },
  crystal1: { make: () => makeCrystals(1), r: 16, far: 1700, scale: [0.9, 2.0] },
  crystal2: { make: () => makeCrystals(2), r: 16, far: 1700, scale: [0.9, 2.0] },
  arch0: { make: () => makeArch(0), r: 32, far: 2000, scale: [0.9, 1.8] },
  arch1: { make: () => makeArch(1), r: 32, far: 2000, scale: [0.9, 1.8] },
  island0: { make: () => makeIsland(0), r: 20, far: 2200, scale: [0.8, 1.8], float: true },
  island1: { make: () => makeIsland(1), r: 20, far: 2200, scale: [0.8, 1.8], float: true },
  ring0: { make: () => makeRing(0), r: 24, far: 2000, scale: [0.9, 1.9] },
  ring1: { make: () => makeRing(1), r: 24, far: 2000, scale: [0.9, 1.9] },
  spire0: { make: () => makeSpire(0), r: 15, far: 2400, scale: [0.8, 1.6] },
  spire1: { make: () => makeSpire(1), r: 15, far: 2400, scale: [0.8, 1.6] },
  balloon0: { make: () => makeBalloonTree(0), r: 16, far: 1500, scale: [0.8, 1.7] },
  balloon1: { make: () => makeBalloonTree(1), r: 16, far: 1500, scale: [0.8, 1.7] },
  balloon2: { make: () => makeBalloonTree(2), r: 16, far: 1500, scale: [0.8, 1.7] },
  flower0: { make: () => makeFlower(0), r: 11, far: 1300, scale: [0.9, 1.9] },
  flower1: { make: () => makeFlower(1), r: 11, far: 1300, scale: [0.9, 1.9] },
  flower2: { make: () => makeFlower(2), r: 11, far: 1300, scale: [0.9, 1.9] },
  mesa0: { make: () => makeMesa(0), r: 16, far: 1900, scale: [1.0, 2.2] },
  mesa1: { make: () => makeMesa(1), r: 16, far: 1900, scale: [1.0, 2.2] },
  planet0: { make: () => makePlanet(0), r: 24, far: 2400, scale: [0.8, 1.8], float: true },
  planet1: { make: () => makePlanet(1), r: 24, far: 2400, scale: [0.8, 1.8], float: true },
};

/** Which kinds each family can be planted as (a zone picks a family, then one of these at random). */
export const GIANT_FAMILIES = {
  mushroom: ['mushroom0', 'mushroom1', 'mushroom2'],
  crystal: ['crystal0', 'crystal1', 'crystal2'],
  arch: ['arch0', 'arch1'],
  island: ['island0', 'island1'],
  ring: ['ring0', 'ring1'],
  spire: ['spire0', 'spire1'],
  balloon: ['balloon0', 'balloon1', 'balloon2'],
  flower: ['flower0', 'flower1', 'flower2'],
  mesa: ['mesa0', 'mesa1'],
  planet: ['planet0', 'planet1'],
};

/** Landmark-sized, standalone versions for the places the road runs through or right beside. */
export const LANDMARK_GIANTS = {
  ring: () => [{ geo: makePortal(), x: 0, z: 0, s: 1 }],
  isles: () => [{ geo: makeIsland(0, 30), x: -26, z: 14, s: 1.15 }, { geo: makeIsland(1, 52), x: 30, z: -30, s: 1.5 }, { geo: makeIsland(0, 72), x: 4, z: 52, s: 0.95 }],
  crystal: () => [{ geo: makeCrystals(0), x: 0, z: 0, s: 1.5 }, { geo: makeCrystals(1), x: 34, z: -18, s: 1.1 }, { geo: makeCrystals(2), x: -30, z: 24, s: 1.25 }],
  fungus: () => [{ geo: makeMushroom(0), x: 0, z: 0, s: 1.3 }, { geo: makeMushroom(1), x: -34, z: 22, s: 1.0 }, { geo: makeMushroom(2), x: 30, z: -26, s: 1.15 }],
};
