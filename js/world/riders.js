// A rigged, realistically proportioned road cyclist on a modern pro superbike: muscled limbs, a pro kit
// (patterned jersey, bib shorts, socks, carbon-soled shoes), a vented road helmet, wraparound sunglasses, gloves
// and a glossy aero race bike with deep carbon wheels, disc brakes, integrated cockpit and a full drivetrain.
// Legs and arms follow the real pedal position through two-bone IK.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const C = (h) => new THREE.Color(h);
const _a = V(), _d = V(), _m = V(), _p = V();

// ---- small maths helpers ---------------------------------------------------------------------------------

/** Middle joint of a two-bone chain A->B. `pole` is the direction the joint prefers to bend. */
function ik(A, B, l1, l2, pole, out) {
  _d.subVectors(B, A);
  const len = _d.length();
  const d = Math.min(Math.max(len, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3);
  _d.divideScalar(len || 1);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _m.copy(A).addScaledVector(_d, a);
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  return out.copy(_m).addScaledVector(_p, h);
}

/** Stretch a unit-height mesh (+y) so it runs from A to B. */
function span(mesh, A, B) {
  _a.subVectors(B, A);
  const len = _a.length();
  mesh.position.copy(A).addScaledVector(_a, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, _a.divideScalar(len || 1));
  mesh.scale.set(1, len, 1);
}

const lerpV = (A, B, t, out) => out.copy(A).lerp(B, t);

// ---- shared geometry builders ------------------------------------------------------------------------------

/** Unit-height tapered cylinder: the +y end is the thin one (rTop). */
const tapered = (rBottom, rTop, seg = 14) => new THREE.CylinderGeometry(rTop, rBottom, 1, seg, 1);

/** Bake a transform and a flat colour into a geometry so many parts can merge into one draw call. */
function bake(geo, color, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx } = {}) {
  geo.applyMatrix4(new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(sx, sy, sz)));
  const c = C(color);
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** A tube between two points, optionally flattened into an aero profile (sx along travel, sz across). */
function tube(a, b, r, color, sx = 1, sz = 1, seg = 8) {
  const A = V(...a), B = V(...b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(1, 1, 1, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(A.clone().lerp(B, 0.5), q, V(r * sx, len, r * sz)));
  return bake(g, color);
}

const mats = new Map();
function standard(color, { metal = 0, rough = 0.6, vertex = false, clearcoat = 0, sheen = 0 } = {}) {
  const k = `${color}|${metal}|${rough}|${vertex}|${clearcoat}|${sheen}`;
  if (!mats.has(k)) {
    const o = { color: vertex ? '#ffffff' : color, metalness: metal, roughness: rough, vertexColors: vertex };
    mats.set(k, clearcoat || sheen
      ? new THREE.MeshPhysicalMaterial({ ...o, clearcoat, clearcoatRoughness: 0.12, sheen, sheenRoughness: 0.5, sheenColor: C('#ffd9c4') })
      : new THREE.MeshStandardMaterial(o));
  }
  return mats.get(k);
}

// ---- anatomy: limbs with a muscle profile ------------------------------------------------------------------------

/** A smooth radius-along-the-limb function from [t, radius] keys (t = 0 at the proximal joint, 1 at the distal one). */
function radiusFn(keys) {
  const pts = new THREE.SplineCurve(keys.map(([t, r]) => new THREE.Vector2(t, r))).getPoints(48);
  return (t) => {
    if (t <= pts[0].x) return pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].x) { const a = pts[i - 1], b = pts[i]; return a.y + ((b.y - a.y) * (t - a.x)) / (b.x - a.x || 1); }
    }
    return pts[pts.length - 1].y;
  };
}

/** Unit-height solid of revolution (centred like `tapered`) following r(t) over t0..t1; `flat` squashes it front-to-back. */
function limb(r, t0 = 0, t1 = 1, { seg = 16, rings = 10, grow = 0, flat = 1 } = {}) {
  const p = [];
  for (let i = 0; i <= rings; i++) { const u = i / rings; p.push(new THREE.Vector2(r(t0 + (t1 - t0) * u) + grow, u - 0.5)); }
  const g = new THREE.LatheGeometry(p, seg);
  if (flat !== 1) g.scale(flat, 1, 1);
  return g;
}

const THIGH = radiusFn([[0, 0.078], [0.14, 0.094], [0.4, 0.098], [0.7, 0.075], [0.9, 0.054], [1, 0.049]]);
const SHIN = radiusFn([[0, 0.05], [0.1, 0.054], [0.3, 0.061], [0.55, 0.047], [0.8, 0.034], [1, 0.03]]);
const UPPER_ARM = radiusFn([[0, 0.058], [0.3, 0.055], [0.7, 0.046], [1, 0.038]]);
const FOREARM = radiusFn([[0, 0.037], [0.25, 0.041], [0.7, 0.032], [1, 0.026]]);

// ---- kit textures ----------------------------------------------------------------------------------------------

const kitCache = new Map();
/** Jersey pattern for the lathe-mapped torso: u runs round the body, v from hip to shoulder. */
function kitTexture(pattern, c1, c2) {
  const key = `${pattern}|${c1}|${c2}`;
  if (kitCache.has(key)) return kitCache.get(key);
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d');
  x.fillStyle = c1; x.fillRect(0, 0, S, S);
  x.fillStyle = c2;
  switch (pattern) {
    case 'hoops': for (const [a, b] of [[0.42, 0.56], [0.7, 0.78]]) x.fillRect(0, S * (1 - b), S, S * (b - a)); break;
    case 'chevron':
      for (let k = 0; k < 3; k++) {
        x.beginPath();
        x.moveTo(0, S * (0.52 + k * 0.17)); x.lineTo(S / 2, S * (0.3 + k * 0.17)); x.lineTo(S, S * (0.52 + k * 0.17));
        x.lineTo(S, S * (0.6 + k * 0.17)); x.lineTo(S / 2, S * (0.38 + k * 0.17)); x.lineTo(0, S * (0.6 + k * 0.17));
        x.fill();
      }
      break;
    case 'split': x.fillRect(0, 0, S / 2, S); break;
    case 'sash': x.beginPath(); x.moveTo(0, S * 0.7); x.lineTo(S, S * 0.15); x.lineTo(S, S * 0.4); x.lineTo(0, S * 0.95); x.fill(); break;
    case 'dots': for (let i = 0; i < 6; i++) for (let j = 0; j < 7; j++) { x.beginPath(); x.arc((i + (j % 2) * 0.5) * (S / 6) + 12, j * (S / 7) + 18, 9, 0, 7); x.fill(); } break;
    case 'fade': { const g = x.createLinearGradient(0, S, 0, 0); g.addColorStop(0, c1); g.addColorStop(1, c2); x.fillStyle = g; x.fillRect(0, 0, S, S); break; }
    case 'bands': x.fillRect(0, 0, S, S * 0.2); x.fillRect(0, S * 0.45, S, S * 0.1); break;
    default: break;
  }
  // soft shading toward the hem so it reads as stretch fabric rather than flat paint
  const shade = x.createLinearGradient(0, S, 0, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.22)'); shade.addColorStop(0.2, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(255,255,255,0.06)');
  x.fillStyle = shade; x.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  kitCache.set(key, t);
  return t;
}

function numberPlate(text, fg = '#1b1b1f', bg = '#ffffff') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d');
  x.fillStyle = bg;
  x.beginPath(); x.roundRect(4, 4, 120, 120, 22); x.fill();
  x.strokeStyle = 'rgba(0,0,0,0.18)'; x.lineWidth = 3; x.stroke();
  x.fillStyle = fg;
  x.font = '800 74px system-ui, -apple-system, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- looks ------------------------------------------------------------------------------------------------------

export const SKINS = ['#f2c9a6', '#e3ad86', '#c98d63', '#9c6a44', '#6f4a32', '#ffdcb8'];
export const HAIRS = ['#1f1710', '#4a3220', '#c79b4c', '#a8452a', '#171717', '#8d8d92', '#e3c067'];

// How the rider sits: the saddle top is at SADDLE_Y + 0.023; the pelvis is sized so its underside just rests on it.
const SADDLE_Y = 0.972;
const SEAT_HIP = 1.09; // hip height when seated
const HIP_RX = 0.108, HIP_RY = 0.097, HIP_RZ = 0.165;
const JERSEY_LEAN = (58 * Math.PI) / 180; // the spine angle the jersey hem is draped level for

/**
 * Let the bottom of the jersey hang: the lowest rings of the torso tube are moved straight down (world space) in proportion to
 * how far back they are, and straight up at the front, so the hem ends level over the hips instead of square to the leaning
 * spine. `lean` is the spine angle the hem is cut level for; `top` is the lathe's height, used to keep the texture unchanged.
 */
function drapeHem(geo, lean, top) {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const sin = Math.sin(lean), cos = Math.cos(lean);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    uv.setY(i, Math.min(1, Math.max(0, y / top)));
    const w = Math.min(1, Math.max(0, (0.14 - y) / 0.17)) ** 1.5;
    if (w <= 0) continue;
    const dy = x * sin * w; // the world-space height change that levels this part of the hem
    pos.setX(i, x - sin * dy);
    pos.setY(i, y + cos * dy);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.computeBoundingSphere();
}

/** Flat-coloured box lying along the line a..b (in the XY plane) and standing `z` out to the side: a frame decal. */
function decal(a, b, z, w, color) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return bake(new THREE.BoxGeometry(Math.hypot(dx, dy), w, 0.003), color, { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z, rz: Math.atan2(dy, dx) });
}

/**
 * Look options: jersey, accent, accent2, pattern, bib, frame, wheel, helmet, helmetStripe, skin, hair,
 * hairStyle ('short' | 'pony' | 'bun'), sock, shoe, number, isUser.
 */
export class RiderModel {
  constructor(look = {}) {
    const L = {
      jersey: '#e63946', accent: '#ffffff', accent2: '#ffd166', pattern: 'hoops', bib: '#15171d', frame: '#2a2d36', wheel: '#17191f',
      helmet: '#f2f2f2', helmetStripe: '#e63946', skin: SKINS[0], hair: HAIRS[1], hairStyle: 'short', sock: '#ffffff', shoe: '#f4f4f4', number: '7', isUser: false, ...look,
    };
    this.look = L;
    this.group = new THREE.Group();
    this.bike = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.bike, this.body);
    this.fine = []; // small details that are hidden at a distance
    this.standing = 0;
    this.time = 0;
    this.isUser = L.isUser;
    this.far = false;

    const skinMat = standard(L.skin, { rough: 0.55, sheen: 0.35 });
    const bibMat = standard(L.bib, { rough: 0.62, sheen: 0.25 });
    const jerseyMat = new THREE.MeshPhysicalMaterial({ map: kitTexture(L.pattern, L.jersey, L.accent), roughness: 0.66, sheen: 0.6, sheenRoughness: 0.5, sheenColor: C('#ffffff') });
    const sleeveMat = new THREE.MeshPhysicalMaterial({ color: L.jersey, roughness: 0.66, sheen: 0.6, sheenRoughness: 0.5, sheenColor: C('#ffffff') });
    const accentMat = standard(L.accent, { rough: 0.6 });
    const sockMat = standard(L.sock, { rough: 0.75 });

    this.#buildBike(L);

    const mesh = (geo, mat, parent = this.body) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };
    const ball = (r, mat, parent = this.body) => mesh(new THREE.SphereGeometry(r, 16, 12), mat, parent);
    const detail = (obj) => { this.fine.push(obj); return obj; };

    // legs: bib shorts over the quad, gripper band, bare thigh, knee, a calf with real shape, sock, shoe
    const SPLIT = 0.62;
    const sockR = (t) => SHIN(0.58 + t * 0.42) + 0.005;
    this.leg = [0, 1].map((i) => ({
      thighA: mesh(limb(THIGH, 0, SPLIT, { grow: 0.003 }), bibMat),
      band: detail(mesh(limb(() => THIGH(SPLIT) + 0.005, 0, 1, { rings: 1, seg: 16 }), accentMat)),
      thighB: mesh(limb(THIGH, SPLIT, 1), skinMat),
      knee: ball(0.054, skinMat),
      shin: mesh(limb(SHIN), skinMat),
      sock: mesh(limb(sockR, 0, 1, { rings: 6 }), sockMat),
      shoe: this.#shoe(L, i ? -1 : 1),
    }));

    // pelvis: a broad ellipsoid (wider than it is deep) in the bib shorts, sitting on the saddle with the thighs coming out of its sides
    this.hips = mesh(new THREE.SphereGeometry(1, 22, 16), bibMat);
    this.hips.scale.set(HIP_RX, HIP_RY, HIP_RZ);

    // torso: an athletic V-taper (waist -> chest -> shoulders) so the kit wraps round it. The jersey is cut with a level hem,
    // so it hangs down over the hips at the back like real cloth instead of ending square to the spine
    const bodyR = radiusFn([[-0.03, 0.14], [0.0, 0.141], [0.09, 0.13], [0.18, 0.119], [0.29, 0.136], [0.4, 0.157], [0.47, 0.163], [0.535, 0.13]]);
    const prof = [];
    for (let y = -0.03; y < 0.5351; y += 0.02) prof.push(new THREE.Vector2(bodyR(y), y));
    prof.push(new THREE.Vector2(0.07, 0.565), new THREE.Vector2(0.001, 0.575));
    const torsoGeo = new THREE.LatheGeometry(prof, 36);
    torsoGeo.scale(1, 1, 1.22);
    drapeHem(torsoGeo, JERSEY_LEAN, 0.575);
    this.torsoGroup = new THREE.Group();
    this.body.add(this.torsoGroup);
    this.torsoMesh = mesh(torsoGeo, jerseyMat, this.torsoGroup);
    const collar = mesh(new THREE.CylinderGeometry(0.066, 0.078, 0.035, 14, 1, true), sleeveMat, this.torsoGroup);
    collar.position.set(0.012, 0.568, 0);
    this.torsoGroup.add(detail(collar));
    // a flat pocket band across the lower back, with two seams
    const pockets = mergeGeometries([
      bake(new THREE.CapsuleGeometry(0.034, 0.25, 3, 8), L.jersey, { x: -0.121, y: 0.12, rx: Math.PI / 2, sx: 0.4 }),
      ...[-0.047, 0.047].map((z) => bake(new THREE.BoxGeometry(0.006, 0.066, 0.004), '#101218', { x: -0.1335, y: 0.122, z })),
    ]);
    const pk = new THREE.Mesh(pockets, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, color: '#d4d4d4' }));
    this.torsoGroup.add(detail(pk));
    // the race number is pinned on, so it curves with the back
    const arc = 0.96;
    const plateGeo = new THREE.CylinderGeometry(0.1425, 0.1425, 0.16, 14, 1, true, -Math.PI / 2 - arc / 2, arc);
    plateGeo.scale(1, 1, 1.22);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshStandardMaterial({ map: numberPlate(L.number, L.isUser ? '#ff3b6b' : '#1b1b1f'), roughness: 0.6, side: THREE.DoubleSide }));
    plate.position.set(0, 0.31, 0);
    this.torsoGroup.add(detail(plate));

    // shoulders (sleeve caps) and arms: sleeve, cuff, bare lower arm, gloved hand wrapped round the hood
    this.arm = [0, 1].map((i) => ({
      cap: ball(0.08, sleeveMat),
      upper: mesh(limb(UPPER_ARM, 0, 0.72, { grow: 0.004 }), sleeveMat),
      cuff: detail(mesh(limb(() => UPPER_ARM(0.72) + 0.008, 0, 1, { rings: 1, seg: 14 }), accentMat)),
      bicep: mesh(limb(UPPER_ARM, 0.72, 1), skinMat),
      elbow: ball(0.04, skinMat),
      fore: mesh(limb(FOREARM), skinMat),
      glove: this.#glove(L, i ? -1 : 1),
    }));

    // head, in human proportions: skull, jaw, nose, chin, ears
    this.neck = mesh(limb(() => 0.053, 0, 1, { rings: 1 }), skinMat);
    this.headGroup = new THREE.Group();
    this.body.add(this.headGroup);
    const skull = mesh(new THREE.SphereGeometry(1, 24, 18), skinMat, this.headGroup);
    skull.scale.set(0.1, 0.115, 0.082);
    const jaw = mesh(new THREE.SphereGeometry(1, 16, 12), skinMat, this.headGroup);
    jaw.scale.set(0.07, 0.06, 0.058); jaw.position.set(0.028, -0.066, 0);
    const chin = new THREE.Mesh(new THREE.SphereGeometry(0.026, 10, 8), skinMat);
    chin.position.set(0.064, -0.094, 0); chin.scale.set(0.9, 0.7, 1.0);
    this.headGroup.add(detail(chin));
    const nose = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.03, 3, 6), skinMat);
    nose.position.set(0.1, -0.018, 0); nose.rotation.z = -0.35; nose.scale.set(1.1, 1, 0.9);
    this.headGroup.add(detail(nose));
    const lips = new THREE.Mesh(new THREE.CapsuleGeometry(0.007, 0.036, 2, 6), standard('#a05a50', { rough: 0.5 }));
    lips.position.set(0.087, -0.066, 0); lips.rotation.x = Math.PI / 2;
    this.headGroup.add(detail(lips));
    for (const z of [-0.082, 0.082]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), skinMat);
      ear.position.set(-0.005, -0.012, z); ear.scale.set(0.55, 1, 0.4);
      this.headGroup.add(detail(ear));
    }
    // road helmet: a vented shell with a tail, centre stripe, and chin straps
    const dome = (sx, sy, sz, phi0, phiLen) => new THREE.SphereGeometry(1, 28, 14, phi0, phiLen, 0, Math.PI * 0.58).scale(sx, sy, sz);
    const helmParts = [bake(dome(0.158, 0.128, 0.11, 0, Math.PI * 2), L.helmet, { x: -0.032, y: 0.022 })];
    for (const [phi0, len] of [[Math.PI - 0.17, 0.34], [-0.17, 0.34]]) helmParts.push(bake(dome(0.1585, 0.1285, 0.1105, phi0, len).scale(1.003, 1.003, 1.003), L.helmetStripe, { x: -0.032, y: 0.022 }));
    for (const [z, len] of [[-0.055, 0.075], [0, 0.095], [0.055, 0.075]]) {
      const surf = 0.022 + 0.128 * Math.sqrt(Math.max(0, 1 - (z / 0.11) ** 2 - 0.01));
      helmParts.push(bake(new THREE.CapsuleGeometry(0.013, len, 3, 6), '#101218', { x: -0.025, y: surf - 0.004, z, rz: -Math.PI / 2, sz: 1, sy: 0.55 }));
    }
    for (const z of [-0.1, 0.1]) {
      helmParts.push(tube([0.0, 0.0, z], [0.05, -0.098, z * 0.32], 0.004, '#1b1d23', 1, 2.2, 5));
      helmParts.push(bake(new THREE.BoxGeometry(0.014, 0.03, 0.006), L.helmetStripe, { x: -0.058, y: -0.01, z: z * 1.03 }));
    }
    this.helmet = mesh(mergeGeometries(helmParts), standard('#ffffff', { vertex: true, rough: 0.28, clearcoat: 1 }), this.headGroup);
    // wraparound sunglasses: one curved mirrored lens across the eyes
    const lens = new THREE.SphereGeometry(1, 24, 8, Math.PI - 1.0, 2.0, 1.1, 0.58);
    lens.scale(0.108, 0.117, 0.089);
    const lensMesh = new THREE.Mesh(lens, new THREE.MeshStandardMaterial({ color: '#232b3d', metalness: 0.75, roughness: 0.1, side: THREE.DoubleSide }));
    lensMesh.position.set(0.0, 0.0, 0);
    this.headGroup.add(detail(lensMesh));
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.02), standard('#14161c', { rough: 0.4 }));
    bridge.position.set(0.1, 0.0, 0);
    this.headGroup.add(detail(bridge));
    // hair: a short nape, a ponytail through the helmet, or a low bun
    this.hair = null;
    const hairMat = standard(L.hair, { rough: 0.8, sheen: 0.4 });
    if (L.hairStyle === 'pony') {
      this.hair = new THREE.Group();
      this.hair.position.set(-0.16, 0.0, 0);
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.22, 4, 8), hairMat);
      tail.position.set(-0.035, -0.11, 0); tail.rotation.z = 0.3; tail.scale.set(1, 1, 1.15); tail.castShadow = true;
      this.hair.add(tail);
      this.headGroup.add(this.hair);
    } else if (L.hairStyle === 'bun') {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), hairMat);
      bun.position.set(-0.14, -0.02, 0); bun.castShadow = true;
      this.headGroup.add(bun);
    }
    const nape = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8, -Math.PI * 0.62, Math.PI * 1.24, Math.PI * 0.46, Math.PI * 0.3), hairMat); // the hair below the helmet at the back of the head
    nape.scale.set(0.103, 0.117, 0.086);
    nape.position.set(-0.012, -0.004, 0);
    this.headGroup.add(nape);

    this.tmp = {
      hip: [V(), V()], ankle: [V(), V()], knee: [V(), V()], sh: [V(), V()], hand: [V(), V()], elbow: [V(), V()], pedal: [V(), V()],
      pole: V(), p1: V(), p2: V(), hipC: V(), shoulderC: V(), head: V(), neckBase: V(),
    };
  }

  // ---- bike --------------------------------------------------------------------------------------------------
  // A modern aero race bike: a deep kammtail down tube, slim sloping top tube, dropped seat stays, a raked fork with
  // aero blades, an integrated cockpit with ergo hoods, 60 mm carbon wheels with disc brakes, and a full drivetrain.

  #buildBike(L) {
    const fc = L.frame, ac = L.accent2;
    const paint = [], comp = [];
    const BB = [0, 0.3, 0], REAR = [-0.415, 0.335, 0], FRONT = [0.585, 0.335, 0];
    const CARBON = '#14161b', STEEL = '#b9bec7', DARK = '#23262e';

    // steering axis: 73 degrees, with a 45 mm fork offset
    const ha = (73 * Math.PI) / 180;
    const down = V(Math.cos(ha), -Math.sin(ha), 0), fwdPerp = V(Math.sin(ha), Math.cos(ha), 0);
    const axisPt = V(...FRONT).addScaledVector(fwdPerp, -0.045);
    const crown = axisPt.clone().addScaledVector(down, -0.375);
    const htBot = crown.clone().addScaledVector(down, -0.012);
    const htTop = crown.clone().addScaledVector(down, -0.175);
    const seatTop = [-0.168, 0.83, 0];

    // frame: deep kammtail down tube, flat top tube, aero seat tube, head tube
    paint.push(tube(BB, [htBot.x + 0.006, htBot.y + 0.03, 0], 0.021, fc, 2.3, 1));
    paint.push(tube([htTop.x + 0.01, htTop.y - 0.012, 0], [seatTop[0] + 0.004, seatTop[1] - 0.008, 0], 0.02, fc, 0.78, 1));
    paint.push(tube(BB, seatTop, 0.018, fc, 2.4, 1));
    paint.push(tube([htBot.x, htBot.y, 0], [htTop.x, htTop.y, 0], 0.023, fc, 1.2, 1.12, 14));
    paint.push(bake(new THREE.CylinderGeometry(0.021, 0.021, 0.095, 14), fc, { x: 0, y: 0.3, rx: Math.PI / 2 }));
    for (const z of [-1, 1]) {
      paint.push(tube([REAR[0], REAR[1], z * 0.058], [seatTop[0] - 0.003, seatTop[1] - 0.045, z * 0.013], 0.008, fc, 1, 1.5));
      paint.push(tube([REAR[0], REAR[1], z * 0.058], [0.0, 0.3, z * 0.032], 0.0115, fc, 0.9, 1.7));
      const blade = new THREE.CatmullRomCurve3([V(crown.x, crown.y, z * 0.036), V((crown.x + FRONT[0]) / 2 + 0.02, (crown.y + FRONT[1]) / 2 + 0.01, z * 0.046), V(FRONT[0], FRONT[1], z * 0.052)]);
      paint.push(bake(new THREE.TubeGeometry(blade, 14, 0.0125, 8), fc));
      paint.push(decal([0.12, 0.38], [0.36, 0.64], z * 0.0192, 0.011, ac));
    }
    paint.push(bake(new THREE.BoxGeometry(0.04, 0.026, 0.11), fc, { x: crown.x, y: crown.y, z: 0 }));
    paint.push(decal([seatTop[0] + 0.045, seatTop[1] - 0.05], [0.0, 0.46], 0.0172, 0.009, ac));

    // components: seatpost, integrated cockpit, hoods, levers, computer
    comp.push(tube([seatTop[0], seatTop[1], 0], [-0.2, SADDLE_Y - 0.02, 0], 0.012, CARBON, 1.5, 0.75));
    const spacer = htTop.clone().addScaledVector(down, -0.05);
    comp.push(tube([htTop.x, htTop.y, 0], [spacer.x, spacer.y, 0], 0.016, CARBON));
    comp.push(tube([spacer.x, spacer.y + 0.004, 0], [0.485, 0.948, 0], 0.016, CARBON, 1, 1.5));
    comp.push(tube([0.485, 0.955, -0.19], [0.485, 0.955, 0.19], 0.011, CARBON, 0.8, 1));
    for (const s of [-1, 1]) {
      const bar = new THREE.CatmullRomCurve3([V(0.485, 0.955, s * 0.185), V(0.53, 0.957, s * 0.2), V(0.595, 0.937, s * 0.205), V(0.628, 0.885, s * 0.205), V(0.61, 0.832, s * 0.205), V(0.545, 0.815, s * 0.205)]);
      comp.push(bake(new THREE.TubeGeometry(bar, 18, 0.0112, 8), CARBON));
      comp.push(bake(new THREE.CapsuleGeometry(0.02, 0.058, 3, 8), DARK, { x: 0.588, y: 0.977, z: s * 0.2, rz: -Math.PI / 2 + 0.16, sz: 0.85 }));
      comp.push(tube([0.628, 0.95, s * 0.2], [0.655, 0.89, s * 0.2], 0.0045, STEEL, 1, 2.2, 5));
    }
    comp.push(bake(new THREE.BoxGeometry(0.044, 0.01, 0.075), '#0c0e12', { x: 0.575, y: 0.972 + 0.0, z: 0, sx: 1 }));
    comp.push(bake(new THREE.BoxGeometry(0.03, 0.004, 0.05), '#4fd1ff', { x: 0.575, y: 0.9785, z: 0 }));
    comp.push(tube([0.52, 0.95, 0], [0.575, 0.965, 0], 0.007, CARBON));

    // saddle rails
    for (const z of [-0.024, 0.024]) comp.push(tube([-0.31, SADDLE_Y, z], [-0.1, SADDLE_Y + 0.005, z * 0.7], 0.0035, STEEL, 1, 1, 5));
    comp.push(bake(new THREE.BoxGeometry(0.03, 0.012, 0.05), CARBON, { x: -0.2, y: SADDLE_Y - 0.017 }));

    // drivetrain: rear mech and jockey wheels, chain, bottle cage and bottle
    comp.push(bake(new THREE.BoxGeometry(0.035, 0.05, 0.028), DARK, { x: REAR[0] - 0.012, y: 0.288, z: 0.072 }));
    comp.push(tube([REAR[0] - 0.012, 0.275, 0.075], [REAR[0] + 0.012, 0.2, 0.075], 0.006, DARK, 1, 1.5, 6));
    for (const [x, y] of [[REAR[0] - 0.012, 0.262], [REAR[0] + 0.012, 0.19]]) comp.push(bake(new THREE.CylinderGeometry(0.0145, 0.0145, 0.012, 12), '#c7ccd6', { x, y, z: 0.075, rx: Math.PI / 2 }));
    comp.push(tube([0.0, 0.405, 0.052], [REAR[0], REAR[1] + 0.042, 0.052], 0.0032, '#4a4d55', 1, 1.6, 5));
    comp.push(tube([0.0, 0.197, 0.052], [REAR[0] + 0.012, 0.178, 0.052], 0.0032, '#4a4d55', 1, 1.6, 5));
    comp.push(tube([REAR[0] + 0.012, 0.178, 0.052], [REAR[0] - 0.012, 0.248, 0.052], 0.0032, '#4a4d55', 1, 1.6, 5));
    const dt = V(htBot.x, htBot.y, 0).sub(V(...BB));
    const dn = V(-dt.y, dt.x, 0).normalize();
    const bottleAt = V(...BB).addScaledVector(dt, 0.42).addScaledVector(dn, 0.066);
    const along = Math.atan2(dt.x, dt.y);
    comp.push(bake(new THREE.TorusGeometry(0.031, 0.0035, 5, 12), '#15171d', { x: bottleAt.x, y: bottleAt.y, rz: -along }));
    paint.push(bake(new THREE.CapsuleGeometry(0.031, 0.125, 4, 10), ac, { x: bottleAt.x, y: bottleAt.y, rz: -along }));
    paint.push(bake(new THREE.CylinderGeometry(0.0125, 0.0125, 0.02, 8), '#ffffff', { x: bottleAt.x - Math.sin(along) * 0.1, y: bottleAt.y + Math.cos(along) * 0.1, rz: -along }));

    // disc brake calipers
    comp.push(bake(new THREE.BoxGeometry(0.03, 0.05, 0.02), '#2c2f38', { x: REAR[0] - 0.045, y: REAR[1] + 0.07, z: -0.04 }));
    comp.push(bake(new THREE.BoxGeometry(0.03, 0.05, 0.02), '#2c2f38', { x: FRONT[0] + 0.045, y: FRONT[1] + 0.07, z: -0.04 }));

    const frame = new THREE.Mesh(mergeGeometries(paint), standard('#ffffff', { vertex: true, metal: 0.35, rough: 0.25, clearcoat: 1 }));
    frame.castShadow = true;
    const parts = new THREE.Mesh(mergeGeometries(comp), standard('#ffffff', { vertex: true, metal: 0.55, rough: 0.4 }));
    parts.castShadow = true;
    this.bike.add(frame, parts);

    // saddle: a long, narrow race saddle with a cutout stripe
    const sad = new THREE.LatheGeometry([[0.001, 0], [0.05, 0.012], [0.068, 0.05], [0.064, 0.1], [0.048, 0.16], [0.032, 0.22], [0.02, 0.27], [0.001, 0.285]].map(([r, y]) => new THREE.Vector2(r, y)), 20);
    sad.rotateZ(-Math.PI / 2);
    sad.scale(1, 0.34, 1);
    const saddleGeo = mergeGeometries([
      bake(sad, '#15171d', { x: -0.335, y: SADDLE_Y }),
      bake(new THREE.BoxGeometry(0.2, 0.004, 0.012), ac, { x: -0.19, y: SADDLE_Y + 0.0135 }),
    ]);
    const saddle = new THREE.Mesh(saddleGeo, standard('#ffffff', { vertex: true, rough: 0.5 }));
    saddle.castShadow = true;
    this.bike.add(saddle);

    // blinking rear light: a friendly marker when you see riders from behind
    this.light = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.05), new THREE.MeshBasicMaterial({ color: C('#ff2a2a').multiplyScalar(3), toneMapped: false }));
    this.light.position.set(-0.222, 0.925, 0);
    this.bike.add(this.light);

    // wheels: 60 mm carbon rims, bladed spokes, cassette (rear), disc rotor, tyre
    const rimProfile = [[0.246, -0.0125], [0.3, -0.0148], [0.3055, -0.012], [0.3055, 0.012], [0.3, 0.0148], [0.246, 0.0125], [0.246, -0.0125]].map(([r, y]) => new THREE.Vector2(r, y));
    const makeWheel = (rear) => {
      const w = new THREE.Group();
      const parts = [
        bake(new THREE.LatheGeometry(rimProfile, 56).rotateX(Math.PI / 2), '#16181d'),
        bake(new THREE.RingGeometry(0.287, 0.2985, 56), L.wheel, { z: 0.0153 }),
        bake(new THREE.RingGeometry(0.287, 0.2985, 56).rotateY(Math.PI), L.wheel, { z: -0.0153 }),
        bake(new THREE.TorusGeometry(0.3185, 0.0148, 10, 64), '#0b0c0f'),
        bake(new THREE.CylinderGeometry(0.02, 0.02, 0.105, 12), '#c9ced6', { rx: Math.PI / 2 }),
        bake(new THREE.RingGeometry(0.255, 0.296, 20, 1, 0, 0.55), L.accent2, { z: 0.01505 }),
        bake(new THREE.RingGeometry(0.255, 0.296, 20, 1, 0, 0.55).rotateY(Math.PI), L.accent2, { z: -0.01505 }),
        bake(new THREE.RingGeometry(0.05, 0.082, 36), '#b9bec7', { z: -0.04 }),
        bake(new THREE.RingGeometry(0.05, 0.082, 36).rotateY(Math.PI), '#b9bec7', { z: -0.04 }),
        bake(new THREE.CylinderGeometry(0.0035, 0.0035, 0.02, 6), '#d8dde6', { x: 0.2937, rz: Math.PI / 2 }),
      ];
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2, zz = i % 2 ? 0.014 : -0.014;
        parts.push(bake(new THREE.BoxGeometry(0.0045, 0.2, 0.0016), '#cfd4dc', { x: Math.cos(a) * 0.145, y: Math.sin(a) * 0.145, z: zz, rz: a - Math.PI / 2 }));
      }
      if (rear) for (let i = 0; i < 6; i++) parts.push(bake(new THREE.CylinderGeometry(0.052 - i * 0.0055, 0.052 - i * 0.0055 - 0.003, 0.0075, 18), i % 2 ? '#8b9099' : '#b9bec7', { z: 0.032 + i * 0.0072, rx: Math.PI / 2 }));
      const wm = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.32, side: THREE.DoubleSide }));
      wm.castShadow = true;
      w.add(wm);
      return w;
    };
    this.rear = makeWheel(true); this.rear.position.set(...REAR);
    this.front = makeWheel(false); this.front.position.set(...FRONT);
    this.bike.add(this.rear, this.front);

    // crankset: carbon arms, aero pedals, and a chainring with a five-arm spider
    this.crankArms = [0, 1].map(() => {
      const arm = new THREE.Mesh(tapered(0.017, 0.012, 8), standard('#16181d', { metal: 0.3, rough: 0.4 }));
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.07), standard('#15171d', { rough: 0.5 }));
      this.bike.add(arm, pedal);
      return { arm, pedal };
    });
    const ringParts = [bake(new THREE.CylinderGeometry(0.106, 0.106, 0.006, 40, 1, true), '#c7ccd6', { rx: Math.PI / 2 }), bake(new THREE.CylinderGeometry(0.1, 0.1, 0.004, 40), '#1a1c22', { rx: Math.PI / 2 })];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ringParts.push(bake(new THREE.BoxGeometry(0.016, 0.085, 0.007), '#16181d', { x: Math.cos(a) * 0.05, y: Math.sin(a) * 0.05, rz: a - Math.PI / 2 }));
    }
    this.ring = new THREE.Mesh(mergeGeometries(ringParts), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.3, side: THREE.DoubleSide }));
    this.ring.position.set(0, 0.3, 0.052);
    this.bike.add(this.ring);
  }

  /** A road cycling shoe: slim carbon sole, sculpted upper, dial and velcro strap, cleat. `side` is +1 / -1 for the outer face. */
  #shoe(L, side) {
    const g = new THREE.Group();
    const sphere = (sx, sy, sz, x, y, z, color) => bake(new THREE.SphereGeometry(1, 14, 10), color, { x, y, z, sx, sy, sz });
    const geo = mergeGeometries([
      bake(new THREE.BoxGeometry(0.262, 0.014, 0.086), '#15171d', { x: 0.034, y: -0.04 }),
      bake(new THREE.BoxGeometry(0.052, 0.01, 0.034), '#0c0d10', { x: 0.03, y: -0.051 }),
      sphere(0.135, 0.043, 0.044, 0.038, -0.006, 0, L.shoe),
      sphere(0.055, 0.034, 0.04, 0.115, -0.016, 0, L.shoe),
      sphere(0.046, 0.05, 0.04, -0.05, 0.022, 0, L.shoe),
      sphere(0.05, 0.026, 0.036, 0.0, 0.03, 0, '#14161b'),
      bake(new THREE.CylinderGeometry(0.0125, 0.0125, 0.01, 14), L.accent2, { x: 0.015, y: 0.038, z: side * 0.036, rx: Math.PI / 2 }),
      bake(new THREE.BoxGeometry(0.024, 0.01, 0.09), L.accent2, { x: 0.07, y: 0.026, rz: -0.28 }),
      bake(new THREE.BoxGeometry(0.02, 0.008, 0.088), L.accent2, { x: 0.105, y: 0.01, rz: -0.28 }),
    ]);
    const m = new THREE.Mesh(geo, standard('#ffffff', { vertex: true, rough: 0.35, clearcoat: 0.6 }));
    m.castShadow = true;
    g.add(m);
    this.body.add(g);
    return g;
  }

  /** A cycling glove: palm, fingers curled round the brake hood, thumb. `side` +1 / -1 picks which way the thumb points. */
  #glove(L, side) {
    const gc = '#16181d';
    const geo = mergeGeometries([
      bake(new THREE.SphereGeometry(1, 12, 9), gc, { x: 0.02, y: 0.0, sx: 0.052, sy: 0.026, sz: 0.04 }),
      bake(new THREE.CapsuleGeometry(0.0145, 0.05, 3, 8), gc, { x: 0.068, y: -0.022, rz: -2.5, sz: 2.3 }),
      bake(new THREE.CapsuleGeometry(0.012, 0.03, 3, 6), gc, { x: 0.038, y: 0.006, z: -side * 0.036, rz: -1.35 }),
      bake(new THREE.CylinderGeometry(0.036, 0.04, 0.03, 12), L.accent, { x: -0.04, y: 0.0, rz: Math.PI / 2 - 0.1 }),
    ]);
    const m = new THREE.Mesh(geo, standard('#ffffff', { vertex: true, rough: 0.7 }));
    m.castShadow = true;
    this.body.add(m);
    return m;
  }

  /** Hide the fiddly details (and most shadows) when the rider is far away. */
  setLOD(distance) {
    const far = distance > 48;
    if (far === this.far) return;
    this.far = far;
    for (const o of this.fine) o.visible = !far;
    this.group.traverse((o) => { if (o.isMesh) o.castShadow = !far || o === this.torsoMesh; });
  }

  /**
   * @param {number} crank crank angle (rad), advancing as the rider pedals
   * @param {number} wheel wheel angle (rad)
   * @param {number} stand 0..1 how far out of the saddle (sprinting)
   * @param {number} dt seconds, for smoothing
   */
  update(crank, wheel, stand, dt, sway = 0) {
    const t = this.tmp;
    this.time += dt;
    this.standing += (stand - this.standing) * (1 - Math.exp(-dt * 5));
    const st = this.standing;
    this.rear.rotation.z = -wheel;
    this.front.rotation.z = -wheel;
    this.light.visible = Math.sin(this.time * 9) > -0.2;

    const rock = Math.sin(crank) * 0.1 * st + sway;
    this.bike.rotation.x = rock;
    this.body.rotation.x = rock * 0.55;

    const theta = -crank;
    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;
      const a = theta + (i ? Math.PI : 0);
      t.pedal[i].set(Math.cos(a) * 0.172, 0.3 + Math.sin(a) * 0.172, side * 0.128);
      t.p1.set(0, 0.3, side * 0.1);
      span(this.crankArms[i].arm, t.p1, t.pedal[i]);
      this.crankArms[i].pedal.position.copy(t.pedal[i]);
    }
    this.ring.rotation.z = theta;

    // pelvis: sat on the saddle with the sit bones just above it; out of the saddle it rises a little, moves forward and the torso drops toward the bars
    const hipY = SEAT_HIP + 0.11 * st, hipX = -0.2 + 0.12 * st;
    const lean = (56 + 3 * st) * (Math.PI / 180);
    const sway2 = Math.sin(crank) * 0.012;
    t.hipC.set(hipX, hipY, sway2);
    t.shoulderC.set(hipX + Math.sin(lean) * 0.52, hipY + Math.cos(lean) * 0.52 - 0.01 * Math.sin(crank * 2), sway2 * 1.5);

    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;
      t.hip[i].set(hipX, hipY - 0.02, side * 0.098 + sway2);
      const pitch = 0.22 * Math.sin(theta + (i ? Math.PI : 0) + 0.6); // ankling through the stroke
      t.ankle[i].set(t.pedal[i].x - 0.05, t.pedal[i].y + 0.1, t.pedal[i].z);
      ik(t.hip[i], t.ankle[i], 0.46, 0.44, t.pole.set(1, 0.12, side * 0.18), t.knee[i]);
      const L = this.leg[i];
      lerpV(t.hip[i], t.knee[i], 0.62, t.p1);
      span(L.thighA, t.hip[i], t.p1);
      L.band.position.copy(t.p1); L.band.quaternion.copy(L.thighA.quaternion); L.band.scale.set(1, 0.03, 1);
      span(L.thighB, t.p1, t.knee[i]);
      L.knee.position.copy(t.knee[i]);
      span(L.shin, t.knee[i], t.ankle[i]);
      lerpV(t.knee[i], t.ankle[i], 0.58, t.p1);
      span(L.sock, t.p1, t.ankle[i]);
      L.shoe.position.set(t.pedal[i].x, t.pedal[i].y + 0.05, t.pedal[i].z);
      L.shoe.rotation.z = pitch - 0.05;

      t.sh[i].set(t.shoulderC.x - 0.01, t.shoulderC.y - 0.03, side * 0.2 + t.shoulderC.z);
      t.hand[i].set(0.575, 0.99, side * 0.2);
      ik(t.sh[i], t.hand[i], 0.3, 0.28, t.pole.set(-0.3, -0.45, side * 0.85), t.elbow[i]);
      const A = this.arm[i];
      A.cap.position.copy(t.sh[i]);
      A.cap.scale.set(1, 0.95, 0.95);
      lerpV(t.sh[i], t.elbow[i], 0.72, t.p1);
      span(A.upper, t.sh[i], t.p1);
      A.cuff.position.copy(t.p1); A.cuff.quaternion.copy(A.upper.quaternion); A.cuff.scale.set(1, 0.03, 1);
      span(A.bicep, t.p1, t.elbow[i]);
      A.elbow.position.copy(t.elbow[i]);
      span(A.fore, t.elbow[i], t.hand[i]);
      A.glove.position.copy(t.hand[i]);
    }

    // pelvis, torso (fixed length, tilting about the hips), neck and head
    this.hips.position.set(hipX - 0.006, hipY + 0.012, sway2);
    this.hips.rotation.set(0, 0, -lean * 0.6);
    this.torsoGroup.position.set(t.hipC.x, t.hipC.y - 0.02, t.hipC.z);
    this.torsoGroup.rotation.set(0, 0, -lean);
    this.torsoGroup.scale.set(1, 1 + Math.sin(this.time * 3.2) * 0.012, 1);
    t.head.set(t.shoulderC.x + 0.085, t.shoulderC.y + 0.165 + Math.sin(crank * 2) * 0.004, t.shoulderC.z);
    this.headGroup.position.copy(t.head);
    this.headGroup.rotation.z = 0.26 - 0.16 * st + Math.sin(crank) * 0.015;
    t.neckBase.set(t.shoulderC.x + 0.02, t.shoulderC.y + 0.02, t.shoulderC.z);
    span(this.neck, t.neckBase, t.head);
    if (this.hair) this.hair.rotation.z = Math.sin(this.time * 7 + crank) * 0.22 + 0.15 + st * 0.3;
  }
}

/** A floating name tag that always faces the camera. */
export function makeNameTag(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,24,0.72)';
  ctx.beginPath(); ctx.roundRect(4, 8, 312, 64, 32); ctx.fill();
  ctx.font = '700 38px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 160, 42);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(1.25, 0.31, 1);
  s.renderOrder = 10;
  return s;
}
