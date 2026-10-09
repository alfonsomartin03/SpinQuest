// A rigged, stylised cyclist in the spirit of a modern indoor-cycling game: smooth tapered limbs, a proper
// kit (patterned jersey with sleeves, bib shorts, socks, shoes), an aero helmet with vents, sunglasses,
// hair and a well-detailed bike. Proportions are playful (big head, hands and shoes) so it reads as
// friendly rather than serious. Legs and arms follow the real pedal position through two-bone IK.

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
function standard(color, { metal = 0, rough = 0.6, vertex = false } = {}) {
  const k = `${color}|${metal}|${rough}|${vertex}`;
  if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: vertex ? '#ffffff' : color, metalness: metal, roughness: rough, vertexColors: vertex }));
  return mats.get(k);
}

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

    const skinMat = standard(L.skin, { rough: 0.62 });
    const bibMat = standard(L.bib, { rough: 0.78 });
    const jerseyMat = new THREE.MeshPhysicalMaterial({ map: kitTexture(L.pattern, L.jersey, L.accent), roughness: 0.72, sheen: 0.5, sheenRoughness: 0.55, sheenColor: C('#ffffff') });
    const sleeveMat = new THREE.MeshPhysicalMaterial({ color: L.jersey, roughness: 0.72, sheen: 0.5, sheenRoughness: 0.55, sheenColor: C('#ffffff') });
    const accentMat = standard(L.accent, { rough: 0.7 });
    const sockMat = standard(L.sock, { rough: 0.8 });
    const shoeMat = standard(L.shoe, { rough: 0.45 });
    const gloveMat = standard('#1a1c22', { rough: 0.75 });

    this.#buildBike(L);

    const mesh = (geo, mat, parent = this.body) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };
    const ball = (r, mat, parent = this.body) => mesh(new THREE.SphereGeometry(r, 14, 10), mat, parent);
    const detail = (obj) => { this.fine.push(obj); return obj; };

    // legs: bib thigh, gripper band, skin thigh, knee, calf, sock, shoe
    this.leg = [0, 1].map(() => ({
      thighA: mesh(tapered(0.092, 0.07), bibMat),
      band: detail(mesh(tapered(0.074, 0.074, 14), accentMat)),
      thighB: mesh(tapered(0.068, 0.062), skinMat),
      knee: ball(0.064, skinMat),
      shin: mesh(tapered(0.058, 0.042), skinMat),
      calf: ball(0.058, skinMat),
      sock: mesh(tapered(0.047, 0.044), sockMat),
      shoe: this.#shoe(shoeMat, L),
    }));
    this.leg.forEach((l) => l.calf.scale.set(0.95, 1.9, 0.95));

    this.hips = ball(0.15, bibMat);
    this.hips.scale.set(1.05, 0.85, 1.1);

    // torso: a lathe profile (waist -> chest -> shoulders) so the kit wraps around it
    const prof = [[0.001, 0], [0.12, 0.012], [0.13, 0.09], [0.125, 0.19], [0.145, 0.31], [0.166, 0.41], [0.16, 0.48], [0.11, 0.54], [0.001, 0.56]].map(([r, y]) => new THREE.Vector2(r, y));
    const torsoGeo = new THREE.LatheGeometry(prof, 28);
    torsoGeo.scale(1, 1, 1.18);
    this.torsoGroup = new THREE.Group();
    this.body.add(this.torsoGroup);
    this.torsoMesh = mesh(torsoGeo, jerseyMat, this.torsoGroup);
    // back pockets and race number
    const pockets = mergeGeometries([-0.075, 0, 0.075].map((z) => bake(new THREE.CapsuleGeometry(0.03, 0.045, 3, 8), L.jersey, { x: -0.157, y: 0.12, z, rx: Math.PI / 2, sx: 1, sy: 1, sz: 0.55 })));
    const pk = new THREE.Mesh(pockets, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, color: '#c8c8c8' }));
    this.torsoGroup.add(detail(pk));
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), new THREE.MeshStandardMaterial({ map: numberPlate(L.number, L.isUser ? '#ff3b6b' : '#1b1b1f'), roughness: 0.6 }));
    plate.position.set(-0.172, 0.3, 0);
    plate.rotation.y = -Math.PI / 2;
    this.torsoGroup.add(detail(plate));

    // shoulders (sleeve caps) and arms
    this.arm = [0, 1].map(() => ({
      cap: ball(0.082, sleeveMat),
      upper: mesh(tapered(0.058, 0.047), sleeveMat),
      cuff: detail(mesh(tapered(0.05, 0.05), accentMat)),
      elbow: ball(0.046, skinMat),
      fore: mesh(tapered(0.044, 0.034), skinMat),
      glove: ball(0.046, gloveMat),
    }));

    // head: bigger than life for charm
    this.neck = mesh(tapered(0.052, 0.046, 10), skinMat);
    this.headGroup = new THREE.Group();
    this.body.add(this.headGroup);
    mesh(new THREE.SphereGeometry(0.108, 18, 14), skinMat, this.headGroup);
    for (const z of [-0.1, 0.1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), skinMat);
      ear.position.set(0, -0.005, z); ear.scale.set(0.6, 1, 0.5);
      this.headGroup.add(detail(ear));
    }
    // aero helmet: shell, vents and a stripe
    const helmParts = [bake(new THREE.SphereGeometry(0.128, 20, 14), L.helmet, { x: -0.03, y: 0.045, sx: 1.4, sy: 0.82, sz: 1.08 })];
    for (const z of [-0.055, 0, 0.055]) helmParts.push(bake(new THREE.CapsuleGeometry(0.014, 0.12, 3, 6), '#15171d', { x: -0.025, y: 0.138, z, rz: Math.PI / 2 }));
    helmParts.push(bake(new THREE.CapsuleGeometry(0.011, 0.1, 3, 6), L.helmetStripe, { x: -0.03, y: 0.152, rz: Math.PI / 2 }));
    mesh(mergeGeometries(helmParts), standard('#ffffff', { vertex: true, rough: 0.32 }), this.headGroup);
    // sunglasses
    const glassParts = [
      bake(new THREE.SphereGeometry(0.046, 12, 8), '#10151f', { x: 0.098, y: 0.012, z: -0.05, sx: 0.55, sy: 0.85, sz: 1.1 }),
      bake(new THREE.SphereGeometry(0.046, 12, 8), '#10151f', { x: 0.098, y: 0.012, z: 0.05, sx: 0.55, sy: 0.85, sz: 1.1 }),
      bake(new THREE.BoxGeometry(0.014, 0.012, 0.215), L.accent2, { x: 0.1, y: 0.04 }),
      bake(new THREE.BoxGeometry(0.1, 0.01, 0.01), L.accent2, { x: 0.05, y: 0.03, z: -0.104 }),
      bake(new THREE.BoxGeometry(0.1, 0.01, 0.01), L.accent2, { x: 0.05, y: 0.03, z: 0.104 }),
    ];
    const shades = new THREE.Mesh(mergeGeometries(glassParts), standard('#ffffff', { vertex: true, rough: 0.12, metal: 0.4 }));
    this.headGroup.add(detail(shades));
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), skinMat);
    nose.position.set(0.108, -0.01, 0);
    this.headGroup.add(detail(nose));
    // hair: a short nape tuft, a ponytail, or a bun
    this.hair = null;
    const hairMat = standard(L.hair, { rough: 0.85 });
    if (L.hairStyle === 'pony') {
      this.hair = new THREE.Group();
      this.hair.position.set(-0.13, 0.0, 0);
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.2, 4, 8), hairMat);
      tail.position.set(-0.04, -0.1, 0); tail.rotation.z = 0.3; tail.castShadow = true;
      this.hair.add(tail);
      this.headGroup.add(this.hair);
    } else if (L.hairStyle === 'bun') {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.058, 10, 8), hairMat);
      bun.position.set(-0.13, 0.1, 0); bun.castShadow = true;
      this.headGroup.add(bun);
    }
    const nape = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 8, -Math.PI * 0.55, Math.PI * 1.1, Math.PI * 0.42, Math.PI * 0.36), hairMat); // the back of the head only
    nape.position.set(-0.012, -0.005, 0);
    this.headGroup.add(nape);

    this.tmp = {
      hip: [V(), V()], ankle: [V(), V()], knee: [V(), V()], sh: [V(), V()], hand: [V(), V()], elbow: [V(), V()], pedal: [V(), V()],
      pole: V(), p1: V(), p2: V(), hipC: V(), shoulderC: V(), head: V(), neckBase: V(),
    };
  }

  // ---- bike --------------------------------------------------------------------------------------------------

  #buildBike(L) {
    const fc = L.frame;
    const parts = [];
    const BB = [0, 0.3, 0], ST = [-0.18, 0.93, 0], HT = [0.43, 0.9, 0], HB = [0.47, 0.66, 0];
    const RW = [-0.55, 0.335, 0];
    parts.push(tube(BB, ST, 0.02, fc, 1.5, 0.85), tube(ST, HT, 0.019, fc, 1.2, 0.9), tube(BB, HB, 0.025, fc, 1.4, 0.95), tube(HT, HB, 0.027, fc, 1.1, 1.1, 10));
    for (const z of [-0.058, 0.058]) {
      parts.push(tube([RW[0], RW[1], z], [-0.17, 0.9, z * 0.35], 0.011, fc));
      parts.push(tube([RW[0], RW[1], z], [0, 0.3, z * 0.6], 0.012, fc));
      parts.push(tube(HB, [0.55, 0.335, z * 1.25], 0.013, fc, 1.3, 0.9));
    }
    parts.push(tube(HT, [0.5, 0.985, 0], 0.016, '#15171d'));
    parts.push(tube([-0.18, 0.93, 0], [-0.205, 1.0, 0], 0.013, '#c9ced6'));
    parts.push(tube([0.52, 0.985, -0.2], [0.52, 0.985, 0.2], 0.013, '#15171d'));
    for (const s of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([V(0.52, 0.985, s * 0.2), V(0.585, 0.965, s * 0.205), V(0.625, 0.915, s * 0.205), V(0.605, 0.86, s * 0.2), V(0.56, 0.845, s * 0.195)]);
      parts.push(bake(new THREE.TubeGeometry(curve, 14, 0.013, 6), '#15171d'));
      parts.push(bake(new THREE.CapsuleGeometry(0.02, 0.05, 3, 6), '#23262e', { x: 0.585, y: 0.985, z: s * 0.2, rz: Math.PI / 2 }));
    }
    parts.push(bake(new THREE.CylinderGeometry(0.062, 0.062, 0.05, 14), '#9aa0aa', { x: RW[0], y: RW[1], z: 0.06, rx: Math.PI / 2 }));
    parts.push(bake(new THREE.BoxGeometry(0.05, 0.1, 0.02), '#2b2f38', { x: RW[0] - 0.01, y: 0.27, z: 0.085 }));
    parts.push(bake(new THREE.BoxGeometry(0.55, 0.006, 0.006), '#2a2c30', { x: -0.275, y: 0.397, z: 0.05 }));
    parts.push(bake(new THREE.BoxGeometry(0.55, 0.006, 0.006), '#2a2c30', { x: -0.275, y: 0.24, z: 0.05 }));
    const dt = V(...HB).sub(V(...BB));
    const bottleAt = V(...BB).addScaledVector(dt, 0.45);
    parts.push(bake(new THREE.CapsuleGeometry(0.034, 0.12, 4, 8), L.accent2, { x: bottleAt.x + 0.045, y: bottleAt.y, rz: -Math.atan2(dt.x, dt.y) }));
    const frame = new THREE.Mesh(mergeGeometries(parts), standard('#ffffff', { vertex: true, metal: 0.45, rough: 0.38 }));
    frame.castShadow = true;
    this.bike.add(frame);

    // saddle
    const saddleGeo = mergeGeometries([
      bake(new THREE.CapsuleGeometry(0.05, 0.15, 4, 10), '#15171d', { x: -0.2, y: 1.025, rz: Math.PI / 2 }),
      bake(new THREE.BoxGeometry(0.1, 0.012, 0.045), L.accent2, { x: -0.265, y: 1.045 }),
    ]);
    saddleGeo.translate(0.2, -1.025, 0);
    saddleGeo.scale(1, 0.55, 1.3);
    saddleGeo.translate(-0.2, 1.025, 0);
    const saddle = new THREE.Mesh(saddleGeo, standard('#ffffff', { vertex: true, rough: 0.55 }));
    saddle.castShadow = true;
    this.bike.add(saddle);

    // blinking rear light: a friendly marker when you see riders from behind
    this.light = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.06), new THREE.MeshBasicMaterial({ color: C('#ff2a2a').multiplyScalar(3), toneMapped: false }));
    this.light.position.set(-0.235, 0.9, 0);
    this.bike.add(this.light);

    // wheels with deep rims
    const makeWheel = () => {
      const w = new THREE.Group();
      const body = mergeGeometries([
        bake(new THREE.TorusGeometry(0.33, 0.019, 8, 48), '#101216'),
        bake(new THREE.CylinderGeometry(0.318, 0.3, 0.05, 44, 1, true), L.wheel, { rx: Math.PI / 2 }),
        bake(new THREE.CylinderGeometry(0.319, 0.319, 0.052, 44, 1, true, 0, Math.PI * 0.34), L.accent2, { rx: Math.PI / 2 }),
        bake(new THREE.CylinderGeometry(0.022, 0.022, 0.11, 10), '#c9ced6', { rx: Math.PI / 2 }),
      ]);
      const wm = new THREE.Mesh(body, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.35, side: THREE.DoubleSide }));
      wm.castShadow = true;
      const pts = [];
      for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; pts.push(0, 0, i % 2 ? 0.012 : -0.012, Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0); }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      w.add(wm, new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: '#d5dae2', transparent: true, opacity: 0.5 })));
      return w;
    };
    this.rear = makeWheel(); this.rear.position.set(-0.55, 0.335, 0);
    this.front = makeWheel(); this.front.position.set(0.55, 0.335, 0);
    this.bike.add(this.rear, this.front);

    // crankset
    this.crankArms = [0, 1].map(() => {
      const arm = new THREE.Mesh(tapered(0.016, 0.012, 8), standard('#aeb3bc', { metal: 0.8, rough: 0.3 }));
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.075), standard('#15171d', { rough: 0.6 }));
      this.bike.add(arm, pedal);
      return { arm, pedal };
    });
    this.ring = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.008, 28), standard('#b5bac3', { metal: 0.8, rough: 0.3 }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.set(0, 0.3, 0.052);
    this.bike.add(this.ring);
  }

  #shoe(shoeMat, L) {
    const g = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.17, 4, 10), shoeMat);
    upper.rotation.z = Math.PI / 2; upper.scale.set(1, 0.85, 0.9); upper.position.set(0.04, 0.02, 0); upper.castShadow = true;
    g.add(upper);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.018, 0.088), standard('#1a1c22', { rough: 0.7 }));
    sole.position.set(0.045, -0.03, 0);
    g.add(sole);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.1), standard(L.accent2, { rough: 0.6 }));
    strap.position.set(0.06, 0.07, 0);
    g.add(strap);
    this.body.add(g);
    return g;
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
    this.ring.rotation.y = crank;

    // pelvis: higher and further forward when standing, and the torso leans less
    const hipY = 1.0 + 0.2 * st, hipX = -0.2 + 0.11 * st;
    const lean = (62 - 20 * st) * (Math.PI / 180);
    const sway2 = Math.sin(crank) * 0.012;
    t.hipC.set(hipX, hipY, sway2);
    t.shoulderC.set(hipX + Math.sin(lean) * 0.52, hipY + Math.cos(lean) * 0.52 - 0.01 * Math.sin(crank * 2), sway2 * 1.5);

    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;
      t.hip[i].set(hipX, hipY - 0.02, side * 0.088 + sway2);
      const pitch = 0.22 * Math.sin(theta + (i ? Math.PI : 0) + 0.6); // ankling through the stroke
      t.ankle[i].set(t.pedal[i].x - 0.05, t.pedal[i].y + 0.1, t.pedal[i].z);
      ik(t.hip[i], t.ankle[i], 0.46, 0.44, t.pole.set(1, 0.12, side * 0.18), t.knee[i]);
      const L = this.leg[i];
      lerpV(t.hip[i], t.knee[i], 0.64, t.p1);
      span(L.thighA, t.hip[i], t.p1);
      L.band.position.copy(t.p1); L.band.quaternion.copy(L.thighA.quaternion); L.band.scale.set(1, 0.03, 1);
      span(L.thighB, t.p1, t.knee[i]);
      L.knee.position.copy(t.knee[i]);
      span(L.shin, t.knee[i], t.ankle[i]);
      lerpV(t.knee[i], t.ankle[i], 0.32, t.p2);
      L.calf.position.copy(t.p2); L.calf.position.x -= 0.022;
      L.calf.quaternion.copy(L.shin.quaternion);
      lerpV(t.knee[i], t.ankle[i], 0.6, t.p1);
      span(L.sock, t.p1, t.ankle[i]);
      L.shoe.position.set(t.pedal[i].x, t.pedal[i].y + 0.05, t.pedal[i].z);
      L.shoe.rotation.z = pitch - 0.05;

      t.sh[i].set(t.shoulderC.x - 0.01, t.shoulderC.y - 0.03, side * 0.205 + t.shoulderC.z);
      t.hand[i].set(0.575, 0.99, side * 0.2);
      ik(t.sh[i], t.hand[i], 0.31, 0.3, t.pole.set(-0.3, -0.45, side * 0.85), t.elbow[i]);
      const A = this.arm[i];
      A.cap.position.copy(t.sh[i]);
      span(A.upper, t.sh[i], t.elbow[i]);
      lerpV(t.sh[i], t.elbow[i], 0.86, t.p1);
      A.cuff.position.copy(t.p1); A.cuff.quaternion.copy(A.upper.quaternion); A.cuff.scale.set(1, 0.035, 1);
      A.elbow.position.copy(t.elbow[i]);
      span(A.fore, t.elbow[i], t.hand[i]);
      A.glove.position.copy(t.hand[i]);
      A.glove.scale.set(1.15, 0.9, 1.05);
    }

    // pelvis, torso (fixed length, tilting about the hips), neck and head
    this.hips.position.set(hipX, hipY - 0.03, sway2);
    this.torsoGroup.position.set(t.hipC.x, t.hipC.y - 0.03, t.hipC.z);
    this.torsoGroup.rotation.set(0, 0, -lean);
    this.torsoGroup.scale.set(1, 1 + Math.sin(this.time * 3.2) * 0.012, 1);
    t.head.set(t.shoulderC.x + 0.1, t.shoulderC.y + 0.16 + Math.sin(crank * 2) * 0.004, t.shoulderC.z);
    this.headGroup.position.copy(t.head);
    this.headGroup.rotation.z = 0.12 - 0.12 * st + Math.sin(crank) * 0.015;
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
