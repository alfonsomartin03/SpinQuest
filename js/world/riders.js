// A rigged cartoon cyclist on a slick aero race bike. The proportions are human, the look is arcade: cel-shaded, bold
// colours, a patterned jersey with the race number printed on the back, bib shorts, socks, gloves, a vented helmet and
// mirrored sunglasses. Legs and arms follow the real pedal position through two-bone IK.
//
// Built to be cheap: each rider is about two dozen meshes and a few thousand triangles. Limbs are single lathes whose
// vertex colours carry the shorts / skin / sock split, the head is one merged mesh, and the bike keeps only the parts you
// can actually see from the chase camera (no spokes, cassette, chain or calipers: the wheels are deep carbon discs).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toon } from './toon.js';

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

// ---- shared geometry builders ------------------------------------------------------------------------------

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
function tube(a, b, r, color, sx = 1, sz = 1, seg = 6) {
  const A = V(...a), B = V(...b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(A.clone().lerp(B, 0.5), q, V(r * sx, len, r * sz)));
  return bake(g, color);
}

/** One vertex-coloured toon material shared by every rider. */
let _vertexMat = null;
const vertexMat = () => (_vertexMat ??= toon({ vertexColors: true }));

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

/**
 * A unit-height limb (centred on the origin like a cylinder, +y distal) whose radius follows r(t). `parts` splits it into
 * bands, [t0, t1, colour, extra radius], each coloured flat, so one mesh can be shorts then skin then sock. Adjacent bands
 * share a seam of zero height, which keeps the colour change crisp.
 */
function limb(r, parts, { seg = 10, rings = 3 } = {}) {
  const prof = [], cols = [];
  for (const [t0, t1, color, grow = 0] of parts) {
    const c = C(color);
    for (let i = 0; i <= rings; i++) {
      const t = t0 + ((t1 - t0) * i) / rings;
      prof.push(new THREE.Vector2(r(t) + grow, t - 0.5));
      cols.push(c);
    }
  }
  const g = new THREE.LatheGeometry(prof, seg);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length / 3; i++) { const c = cols[i % prof.length]; col.set([c.r, c.g, c.b], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

const THIGH = radiusFn([[0, 0.078], [0.14, 0.094], [0.4, 0.098], [0.7, 0.075], [0.9, 0.054], [1, 0.049]]);
const SHIN = radiusFn([[0, 0.05], [0.1, 0.054], [0.3, 0.061], [0.55, 0.047], [0.8, 0.034], [1, 0.03]]);
const UPPER_ARM = radiusFn([[0, 0.058], [0.3, 0.055], [0.7, 0.046], [1, 0.038]]);
const FOREARM = radiusFn([[0, 0.037], [0.25, 0.041], [0.7, 0.032], [1, 0.026]]);

// ---- kit texture -----------------------------------------------------------------------------------------------

const kitCache = new Map();
/**
 * Jersey for the lathe-mapped torso: u runs round the body (the back is at u = 0.75), v from hip to shoulder. The back
 * carries the pocket band and the race number, so those cost no geometry at all.
 */
function kitTexture(pattern, c1, c2, number, hot) {
  const key = `${pattern}|${c1}|${c2}|${number}|${hot}`;
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
  // the pocket band across the lower back, with two seams
  const bx = S * 0.75, py = S * (1 - 0.2), ph = S * 0.1;
  x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(bx - S * 0.1, py, S * 0.2, ph);
  x.fillStyle = 'rgba(0,0,0,0.55)'; for (const k of [-0.033, 0.033]) x.fillRect(bx + S * k - 1, py, 2, ph);
  // the race number: the texture is stretched about 1.7x more vertically than horizontally, so draw it squashed to look square
  const w = S * 0.165, h = w * 1.68, cy = S * (1 - 0.54);
  x.save();
  x.translate(bx, cy);
  x.fillStyle = '#ffffff';
  x.beginPath(); x.roundRect(-w / 2, -h / 2, w, h, w * 0.18); x.fill();
  x.lineWidth = 2; x.strokeStyle = 'rgba(0,0,0,0.3)'; x.stroke();
  x.fillStyle = hot ? '#ff3b6b' : '#1b1b1f';
  x.font = `800 ${w * 0.78}px system-ui, -apple-system, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.scale(1, 1.68);
  x.fillText(number, 0, 2);
  x.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  kitCache.set(key, t);
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

/** A coloured ellipsoid (radius `r` unless sx/sy/sz are given). */
const ball = (r, color, o = {}, w = 10, h = 7) => bake(new THREE.SphereGeometry(1, w, h), color, { sx: r, sy: r, sz: r, ...o });

/**
 * Look options: jersey, accent, accent2, pattern, bib, frame, wheel, helmet, helmetStripe, skin, hair,
 * hairStyle ('short' | 'pony' | 'bun'), sock, shoe, number, isUser.
 */
export class RiderModel {
  constructor(look = {}) {
    const L = {
      jersey: '#e63946', accent: '#ffffff', accent2: '#ffd166', pattern: 'hoops', bib: '#2a2f45', frame: '#2a2d36', wheel: '#17191f',
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

    const vmat = vertexMat();
    const mesh = (geo, m = vmat, parent = this.body) => { const o = new THREE.Mesh(geo, m); o.castShadow = true; parent.add(o); return o; };
    const detail = (obj) => { this.fine.push(obj); return obj; };

    this.#buildBike(L);

    // legs: one lathe each for thigh (bib shorts, gripper band, bare skin) and shin (calf, then sock), with the knee baked in
    this.leg = [0, 1].map((i) => ({
      thigh: mesh(limb(THIGH, [[0, 0.62, L.bib, 0.003], [0.62, 0.66, L.accent, 0.006], [0.66, 1, L.skin]], { rings: 3 })),
      shin: mesh(mergeGeometries([
        limb(SHIN, [[0, 0.57, L.skin], [0.57, 1, L.sock, 0.005]], { rings: 4 }),
        ball(0.054, L.skin, { y: -0.5, sy: 0.054 / 0.44 }, 9, 6),
      ])),
      shoe: this.#shoe(L, i ? -1 : 1),
    }));

    // pelvis: a broad ellipsoid (wider than it is deep) in the bib shorts, sat on the saddle with the thighs coming out of its sides
    this.hips = mesh(bake(new THREE.SphereGeometry(1, 14, 10), L.bib, { sx: HIP_RX, sy: HIP_RY, sz: HIP_RZ }));

    // torso: an athletic V-taper (waist -> chest -> shoulders). The jersey is draped so its hem ends level over the hips
    const bodyR = radiusFn([[-0.03, 0.14], [0.0, 0.141], [0.09, 0.13], [0.18, 0.119], [0.29, 0.136], [0.4, 0.157], [0.47, 0.163], [0.535, 0.13]]);
    const prof = [];
    for (let y = -0.03; y < 0.5351; y += 0.045) prof.push(new THREE.Vector2(bodyR(y), y));
    prof.push(new THREE.Vector2(0.07, 0.565), new THREE.Vector2(0.001, 0.575));
    const torsoGeo = new THREE.LatheGeometry(prof, 24);
    torsoGeo.scale(1, 1, 1.22);
    drapeHem(torsoGeo, JERSEY_LEAN, 0.575);
    this.torsoGroup = new THREE.Group();
    this.body.add(this.torsoGroup);
    this.torsoMesh = mesh(torsoGeo, toon({ map: kitTexture(L.pattern, L.jersey, L.accent, L.number, L.isUser) }), this.torsoGroup);

    // arms: sleeve, cuff, bare lower arm (shoulder and elbow baked in), and a glove wrapped round the hood
    this.arm = [0, 1].map((i) => ({
      upper: mesh(mergeGeometries([
        limb(UPPER_ARM, [[0, 0.72, L.jersey, 0.004], [0.72, 0.77, L.accent, 0.008], [0.77, 1, L.skin]], { rings: 3 }),
        ball(0.08, L.jersey, { y: -0.5, sy: 0.08 / 0.3, sx: 0.076, sz: 0.076 }, 9, 6),
      ])),
      fore: mesh(mergeGeometries([limb(FOREARM, [[0, 1, L.skin]], { rings: 3 }), ball(0.04, L.skin, { y: -0.5, sy: 0.04 / 0.28 }, 8, 6)])),
      glove: this.#glove(L, i ? -1 : 1),
    }));

    this.neck = mesh(limb(() => 0.053, [[0, 1, L.skin]], { rings: 1, seg: 8 }));

    // head: skull, jaw and helmet in one mesh; the small facial features are a second mesh that is dropped at a distance
    this.headGroup = new THREE.Group();
    this.body.add(this.headGroup);
    const dome = (sx, sy, sz, phi0, phiLen, color, o = {}) => bake(new THREE.SphereGeometry(1, 16, 8, phi0, phiLen, 0, Math.PI * 0.58).scale(sx, sy, sz), color, o);
    const headParts = [
      ball(1, L.skin, { sx: 0.1, sy: 0.115, sz: 0.082 }, 14, 10),
      ball(1, L.skin, { sx: 0.07, sy: 0.06, sz: 0.058, x: 0.028, y: -0.066 }, 10, 7),
      dome(0.158, 0.128, 0.11, 0, Math.PI * 2, L.helmet, { x: -0.032, y: 0.022 }),
      // a stripe down the middle of the helmet, front and back
      dome(0.1585, 0.1285, 0.1105, Math.PI - 0.17, 0.34, L.helmetStripe, { x: -0.032, y: 0.022 }),
      dome(0.1585, 0.1285, 0.1105, -0.17, 0.34, L.helmetStripe, { x: -0.032, y: 0.022 }),
      bake(new THREE.SphereGeometry(1, 10, 4, -Math.PI * 0.62, Math.PI * 1.24, Math.PI * 0.46, Math.PI * 0.3).scale(0.103, 0.117, 0.086), L.hair, { x: -0.012, y: -0.004 }),
    ];
    for (const z of [-0.055, 0, 0.055]) headParts.push(bake(new THREE.BoxGeometry(0.1, 0.012, 0.016), '#2a2f44', { x: -0.025, y: 0.145 - Math.abs(z) * 0.25, z }));
    if (L.hairStyle === 'bun') headParts.push(ball(0.052, L.hair, { x: -0.14, y: -0.02 }, 8, 6));
    this.head = mesh(mergeGeometries(headParts), vmat, this.headGroup);
    const face = mergeGeometries([
      bake(new THREE.CapsuleGeometry(0.014, 0.03, 2, 5), L.skin, { x: 0.1, y: -0.018, rz: -0.35 }),
      ball(1, L.skin, { sx: 0.024, sy: 0.019, sz: 0.026, x: 0.064, y: -0.094 }, 7, 5),
      ball(1, L.skin, { sx: 0.014, sy: 0.026, sz: 0.01, x: -0.005, y: -0.012, z: -0.082 }, 6, 5),
      ball(1, L.skin, { sx: 0.014, sy: 0.026, sz: 0.01, x: -0.005, y: -0.012, z: 0.082 }, 6, 5),
      bake(new THREE.SphereGeometry(1, 14, 4, Math.PI - 1.0, 2.0, 1.1, 0.58).scale(0.108, 0.117, 0.089), '#232b3d'), // the mirrored wraparound lens
      bake(new THREE.BoxGeometry(0.012, 0.014, 0.02), L.accent2, { x: 0.1 }),
    ]);
    this.headGroup.add(detail(new THREE.Mesh(face, toon({ vertexColors: true, side: THREE.DoubleSide }))));
    // hair: a short nape is part of the head mesh; a ponytail swings on its own
    this.hair = null;
    if (L.hairStyle === 'pony') {
      this.hair = new THREE.Group();
      this.hair.position.set(-0.16, 0.0, 0);
      const tail = new THREE.Mesh(bake(new THREE.CapsuleGeometry(0.03, 0.22, 3, 6), L.hair, { x: -0.035, y: -0.11, rz: 0.3 }), vmat);
      tail.castShadow = true;
      this.hair.add(tail);
      this.headGroup.add(this.hair);
    }

    this.tmp = {
      hip: [V(), V()], ankle: [V(), V()], knee: [V(), V()], sh: [V(), V()], hand: [V(), V()], elbow: [V(), V()], pedal: [V(), V()],
      pole: V(), p1: V(), p2: V(), hipC: V(), shoulderC: V(), head: V(), neckBase: V(),
    };
  }

  // ---- bike --------------------------------------------------------------------------------------------------
  // An aero race bike with a deep kammtail down tube, raked fork, integrated cockpit and deep carbon disc wheels.

  #buildBike(L) {
    const fc = L.frame, ac = L.accent2;
    const frameParts = [], detailParts = [];
    const BB = [0, 0.3, 0], REAR = [-0.415, 0.335, 0], FRONT = [0.585, 0.335, 0];
    const CARBON = '#2a2f44', STEEL = '#b9bec7', DARK = '#3b4157';

    // steering axis: 73 degrees, with a 45 mm fork offset
    const ha = (73 * Math.PI) / 180;
    const down = V(Math.cos(ha), -Math.sin(ha), 0), fwdPerp = V(Math.sin(ha), Math.cos(ha), 0);
    const axisPt = V(...FRONT).addScaledVector(fwdPerp, -0.045);
    const crown = axisPt.clone().addScaledVector(down, -0.375);
    const htBot = crown.clone().addScaledVector(down, -0.012);
    const htTop = crown.clone().addScaledVector(down, -0.175);
    const seatTop = [-0.168, 0.83, 0];

    // frame: deep down tube, flat top tube, aero seat tube, head tube, stays, fork
    frameParts.push(tube(BB, [htBot.x + 0.006, htBot.y + 0.03, 0], 0.021, fc, 2.3, 1));
    frameParts.push(tube([htTop.x + 0.01, htTop.y - 0.012, 0], [seatTop[0] + 0.004, seatTop[1] - 0.008, 0], 0.02, fc, 0.78, 1));
    frameParts.push(tube(BB, seatTop, 0.018, fc, 2.4, 1));
    frameParts.push(tube([htBot.x, htBot.y, 0], [htTop.x, htTop.y, 0], 0.023, fc, 1.2, 1.12, 8));
    for (const z of [-1, 1]) {
      frameParts.push(tube([REAR[0], REAR[1], z * 0.058], [seatTop[0] - 0.003, seatTop[1] - 0.045, z * 0.013], 0.008, fc, 1, 1.5));
      frameParts.push(tube([REAR[0], REAR[1], z * 0.058], [0.0, 0.3, z * 0.032], 0.0115, fc, 0.9, 1.7));
      const blade = new THREE.CatmullRomCurve3([V(crown.x, crown.y, z * 0.036), V((crown.x + FRONT[0]) / 2 + 0.02, (crown.y + FRONT[1]) / 2 + 0.01, z * 0.046), V(FRONT[0], FRONT[1], z * 0.052)]);
      frameParts.push(bake(new THREE.TubeGeometry(blade, 6, 0.0125, 6), fc));
      detailParts.push(decal([0.12, 0.38], [0.36, 0.64], z * 0.0192, 0.011, ac));
    }
    frameParts.push(bake(new THREE.BoxGeometry(0.04, 0.026, 0.11), fc, { x: crown.x, y: crown.y, z: 0 }));
    detailParts.push(decal([seatTop[0] + 0.045, seatTop[1] - 0.05], [0.0, 0.46], 0.0172, 0.009, ac));

    // seatpost, integrated cockpit, hoods
    frameParts.push(tube([seatTop[0], seatTop[1], 0], [-0.2, SADDLE_Y - 0.02, 0], 0.012, CARBON, 1.5, 0.75));
    const spacer = htTop.clone().addScaledVector(down, -0.05);
    frameParts.push(tube([htTop.x, htTop.y, 0], [spacer.x, spacer.y, 0], 0.016, CARBON));
    frameParts.push(tube([spacer.x, spacer.y + 0.004, 0], [0.485, 0.948, 0], 0.016, CARBON, 1, 1.5));
    frameParts.push(tube([0.485, 0.955, -0.19], [0.485, 0.955, 0.19], 0.011, CARBON, 0.8, 1));
    for (const s of [-1, 1]) {
      const bar = new THREE.CatmullRomCurve3([V(0.485, 0.955, s * 0.185), V(0.53, 0.957, s * 0.2), V(0.595, 0.937, s * 0.205), V(0.628, 0.885, s * 0.205), V(0.61, 0.832, s * 0.205), V(0.545, 0.815, s * 0.205)]);
      frameParts.push(bake(new THREE.TubeGeometry(bar, 10, 0.0112, 6), CARBON));
      frameParts.push(bake(new THREE.CapsuleGeometry(0.02, 0.058, 2, 6), DARK, { x: 0.588, y: 0.977, z: s * 0.2, rz: -Math.PI / 2 + 0.16, sz: 0.85 }));
    }

    // saddle: a long, narrow race saddle with a stripe
    const sad = new THREE.LatheGeometry([[0.001, 0], [0.05, 0.012], [0.068, 0.05], [0.064, 0.1], [0.048, 0.16], [0.032, 0.22], [0.02, 0.27], [0.001, 0.285]].map(([r, y]) => new THREE.Vector2(r, y)), 12);
    sad.rotateZ(-Math.PI / 2);
    sad.scale(1, 0.34, 1);
    frameParts.push(bake(sad, '#2b2f42', { x: -0.335, y: SADDLE_Y }));
    frameParts.push(bake(new THREE.BoxGeometry(0.2, 0.004, 0.012), ac, { x: -0.19, y: SADDLE_Y + 0.0135 }));

    // the bits you only notice up close: bottle, computer, saddle rails, brake levers
    const dt = V(htBot.x, htBot.y, 0).sub(V(...BB));
    const dn = V(-dt.y, dt.x, 0).normalize();
    const bottleAt = V(...BB).addScaledVector(dt, 0.42).addScaledVector(dn, 0.066);
    const along = Math.atan2(dt.x, dt.y);
    detailParts.push(bake(new THREE.CapsuleGeometry(0.031, 0.125, 3, 8), ac, { x: bottleAt.x, y: bottleAt.y, rz: -along }));
    detailParts.push(bake(new THREE.BoxGeometry(0.044, 0.01, 0.075), '#0c0e12', { x: 0.575, y: 0.972 }));
    detailParts.push(bake(new THREE.BoxGeometry(0.03, 0.004, 0.05), '#4fd1ff', { x: 0.575, y: 0.9785 }));
    for (const z of [-0.024, 0.024]) detailParts.push(tube([-0.31, SADDLE_Y, z], [-0.1, SADDLE_Y + 0.005, z * 0.7], 0.0035, STEEL, 1, 1, 4));
    for (const s of [-1, 1]) detailParts.push(tube([0.628, 0.95, s * 0.2], [0.655, 0.89, s * 0.2], 0.0045, STEEL, 1, 2.2, 4));

    const frame = new THREE.Mesh(mergeGeometries(frameParts), vertexMat());
    frame.castShadow = true;
    this.bike.add(frame);
    const det = new THREE.Mesh(mergeGeometries(detailParts), vertexMat());
    this.fine.push(det);
    this.bike.add(det);

    // blinking rear light: a friendly marker when you see riders from behind
    this.light = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.05), new THREE.MeshBasicMaterial({ color: C('#ff2a2a').multiplyScalar(3), toneMapped: false }));
    this.light.position.set(-0.222, 0.925, 0);
    this.bike.add(this.light);

    // wheels: deep carbon discs with a coloured decal that makes the spin readable, a chunky tyre, and a hub
    const rimProfile = [[0.05, -0.012], [0.3, -0.0148], [0.3055, -0.012], [0.3055, 0.012], [0.3, 0.0148], [0.05, 0.012]].map(([r, y]) => new THREE.Vector2(r, y));
    const wheelGeo = () => {
      const parts = [
        bake(new THREE.LatheGeometry(rimProfile, 28).rotateX(Math.PI / 2), L.wheel),
        bake(new THREE.TorusGeometry(0.3185, 0.0155, 6, 32), '#0b0c0f'),
        bake(new THREE.CylinderGeometry(0.02, 0.02, 0.07, 8).rotateX(Math.PI / 2), '#d8dde6'),
      ];
      for (const a of [0, Math.PI]) for (const z of [0.0153, -0.0153]) {
        const ring = new THREE.RingGeometry(0.17, 0.296, 6, 1, a, 0.7);
        if (z < 0) ring.rotateY(Math.PI);
        parts.push(bake(ring, L.accent2, { z }));
      }
      return mergeGeometries(parts);
    };
    const makeWheel = () => {
      const w = new THREE.Group();
      const wm = new THREE.Mesh(wheelGeo(), vertexMat());
      wm.castShadow = true;
      w.add(wm);
      return w;
    };
    this.rear = makeWheel(); this.rear.position.set(...REAR);
    this.front = makeWheel(); this.front.position.set(...FRONT);
    this.bike.add(this.rear, this.front);

    // crankset: both arms and the chainring turn together as one piece (the pedals sit under the shoes)
    const crankParts = [
      bake(new THREE.CylinderGeometry(0.106, 0.106, 0.008, 18).rotateX(Math.PI / 2), '#c7ccd6', { z: 0.052 }),
      bake(new THREE.BoxGeometry(0.172, 0.022, 0.016), '#30354a', { x: 0.086, z: 0.114 }),
      bake(new THREE.BoxGeometry(0.172, 0.022, 0.016), '#30354a', { x: -0.086, z: -0.114 }),
    ];
    this.ring = new THREE.Mesh(mergeGeometries(crankParts), vertexMat());
    this.ring.position.set(0, 0.3, 0);
    this.bike.add(this.ring);
  }

  /** A road cycling shoe: slim sole, sculpted upper, dial and strap. `side` is +1 / -1 for the outer face. */
  #shoe(L, side) {
    const g = new THREE.Group();
    const geo = mergeGeometries([
      bake(new THREE.BoxGeometry(0.262, 0.014, 0.086), '#2b2f42', { x: 0.034, y: -0.04 }),
      ball(1, L.shoe, { sx: 0.135, sy: 0.043, sz: 0.044, x: 0.038, y: -0.006 }, 9, 6),
      ball(1, L.shoe, { sx: 0.055, sy: 0.034, sz: 0.04, x: 0.115, y: -0.016 }, 7, 5),
      ball(1, L.shoe, { sx: 0.046, sy: 0.05, sz: 0.04, x: -0.05, y: 0.022 }, 7, 5),
      bake(new THREE.BoxGeometry(0.024, 0.01, 0.09), L.accent2, { x: 0.07, y: 0.03, rz: -0.28 }),
      bake(new THREE.CylinderGeometry(0.0125, 0.0125, 0.01, 8).rotateX(Math.PI / 2), L.accent2, { x: 0.015, y: 0.038, z: side * 0.04 }),
    ]);
    const m = new THREE.Mesh(geo, vertexMat());
    m.castShadow = true;
    g.add(m);
    this.body.add(g);
    return g;
  }

  /** A cycling glove: palm, fingers curled round the brake hood, thumb. `side` +1 / -1 picks which way the thumb points. */
  #glove(L, side) {
    const gc = '#2b3046';
    const geo = mergeGeometries([
      ball(1, gc, { sx: 0.052, sy: 0.026, sz: 0.04, x: 0.02 }, 8, 6),
      bake(new THREE.CapsuleGeometry(0.0145, 0.05, 2, 6), gc, { x: 0.068, y: -0.022, rz: -2.5, sz: 2.3 }),
      bake(new THREE.CapsuleGeometry(0.012, 0.03, 2, 5), gc, { x: 0.038, y: 0.006, z: -side * 0.036, rz: -1.35 }),
      bake(new THREE.CylinderGeometry(0.036, 0.04, 0.03, 8), L.accent, { x: -0.04, rz: Math.PI / 2 - 0.1 }),
    ]);
    const m = new THREE.Mesh(geo, vertexMat());
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
      span(L.thigh, t.hip[i], t.knee[i]);
      span(L.shin, t.knee[i], t.ankle[i]);
      L.shoe.position.set(t.pedal[i].x, t.pedal[i].y + 0.05, t.pedal[i].z);
      L.shoe.rotation.z = pitch - 0.05;

      t.sh[i].set(t.shoulderC.x - 0.01, t.shoulderC.y - 0.03, side * 0.2 + t.shoulderC.z);
      t.hand[i].set(0.575, 0.99, side * 0.2);
      ik(t.sh[i], t.hand[i], 0.3, 0.28, t.pole.set(-0.3, -0.45, side * 0.85), t.elbow[i]);
      const A = this.arm[i];
      span(A.upper, t.sh[i], t.elbow[i]);
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
