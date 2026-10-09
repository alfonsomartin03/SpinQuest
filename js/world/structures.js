// Built structures along the road: the rock tunnel and the covered wooden bridge.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUNNEL, BRIDGE } from '../course.js';
import { frame } from './geo.js';
import { ribbon } from './road.js';
import { makeWood, makeStone, makeConcrete, makeRoofTiles, makeSign } from './textures.js';
import { smoothstep as sm, mulberry32 } from './noise.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Basis for a structure sitting on the road at distance d. local +x = right, +y = up, +z = backwards along the road. */
function roadBasis(d, { pitch = true } = {}) {
  const f = frame(d);
  const fwd = pitch ? V(f.tx, f.grade, f.tz).normalize() : V(f.tx, 0, f.tz);
  let up = V(0, 1, 0);
  up = up.sub(fwd.clone().multiplyScalar(up.dot(fwd))).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, up);
  const m = new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate());
  m.setPosition(f.x, f.y, f.z);
  return m;
}

const boxGeo = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; };

// ---- tunnel -------------------------------------------------------------------------------------------

/** The rock mass over the tunnel: a dome across the road, tallest in the middle. */
export const MASS_W = 32; // half width (m)
export const MASS_H = 19; // height above the road at the centre (m)
export const massHeight = (lat) => MASS_H * Math.pow(Math.max(0, 1 - (lat / MASS_W) ** 2), 0.6);

const ARCH_R = 5.4; // half width of the bore
const ARCH_WALL = 3.0; // straight wall height before the arch

function archProfile(segs = 14) {
  const pts = [[-ARCH_R, 0], [-ARCH_R, ARCH_WALL]];
  for (let i = 1; i < segs; i++) {
    const a = Math.PI - (Math.PI * i) / segs;
    pts.push([Math.cos(a) * ARCH_R, ARCH_WALL + Math.sin(a) * (ARCH_R * 0.86)]);
  }
  pts.push([ARCH_R, ARCH_WALL], [ARCH_R, 0]);
  return pts;
}

export function buildTunnel({ anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'tunnel';
  const prof = archProfile();
  const step = 2;
  const rows = Math.ceil((TUNNEL.end - TUNNEL.start) / step) + 1;
  const pos = [], uv = [], idx = [];
  const f = {};
  for (let r = 0; r < rows; r++) {
    const d = TUNNEL.start + r * step;
    frame(d, f);
    prof.forEach(([lat, h], k) => {
      pos.push(f.x + f.rx * lat, f.y + h, f.z + f.rz * lat);
      uv.push(k / (prof.length - 1) * 3, d / 5);
    });
  }
  const n = prof.length;
  for (let r = 0; r < rows - 1; r++) {
    for (let k = 0; k < n - 1; k++) {
      const a = r * n + k, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const concrete = makeConcrete(anisotropy);
  const bore = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.9, side: THREE.DoubleSide }));
  bore.receiveShadow = false;
  group.add(bore);

  // ceiling lights: bright strips that bloom softly
  const lightGeo = boxGeo(2.6, 0.07, 0.22, 0, 0, 0); // long axis along the road (local x)
  const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff0c8').multiplyScalar(3.2), toneMapped: false });
  const lightMatrices = [];
  for (let d = TUNNEL.start + 8; d < TUNNEL.end - 4; d += 9) {
    frame(d, f);
    for (const lat of [-1.9, 1.9]) {
      const m = new THREE.Matrix4();
      const fwd = V(f.tx, f.grade, f.tz).normalize();
      const up = V(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      m.makeBasis(fwd, up, right);
      const h = ARCH_WALL + ARCH_R * 0.86 * Math.sqrt(Math.max(0, 1 - (lat / ARCH_R) ** 2)) - 0.1;
      m.setPosition(f.x + f.rx * lat, f.y + h, f.z + f.rz * lat);
      lightMatrices.push(m);
    }
  }
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, lightMatrices.length);
  lightMatrices.forEach((m, i) => lights.setMatrixAt(i, m));
  lights.frustumCulled = false;
  group.add(lights);

  // stone portals at both ends
  const stone = makeStone(anisotropy, 150);
  stone.repeat.set(0.16, 0.16);
  const stoneMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 });
  const shape = new THREE.Shape();
  shape.moveTo(-MASS_W, -8);
  for (let i = 0; i <= 32; i++) { const lat = -MASS_W + (i / 32) * MASS_W * 2; shape.lineTo(lat, massHeight(lat)); }
  shape.lineTo(MASS_W, -8);
  shape.lineTo(-MASS_W, -8);
  const hole = new THREE.Path();
  hole.moveTo(-ARCH_R - 0.6, -3.1);
  hole.lineTo(-ARCH_R - 0.6, ARCH_WALL);
  const segs = 18;
  for (let i = 1; i < segs; i++) {
    const a = Math.PI - (Math.PI * i) / segs;
    hole.lineTo(Math.cos(a) * (ARCH_R + 0.6), ARCH_WALL + Math.sin(a) * (ARCH_R * 0.86 + 0.5));
  }
  hole.lineTo(ARCH_R + 0.6, ARCH_WALL);
  hole.lineTo(ARCH_R + 0.6, -3.1);
  hole.lineTo(-ARCH_R - 0.6, -3.1);
  shape.holes.push(hole);
  const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false });
  for (const [d, flip] of [[TUNNEL.start + 3, false], [TUNNEL.end - 3, true]]) {
    const wall = new THREE.Mesh(wallGeo, stoneMat);
    const m = roadBasis(d, { pitch: false });
    if (flip) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    wall.applyMatrix4(m);
    wall.castShadow = true; wall.receiveShadow = true;
    group.add(wall);
  }
  // the hill over the tunnel, lofted along the road between the two portals
  const mRng = mulberry32(8);
  const mRows = Math.ceil((TUNNEL.end - TUNNEL.start) / 4) + 1;
  const mCols = 25;
  const mp = [], mc = [], mi = [];
  const rockC = new THREE.Color('#7b776f'), grassC = new THREE.Color('#5f8a4a'), darkC = new THREE.Color('#4a4944');
  for (let r = 0; r < mRows; r++) {
    const d = TUNNEL.start + ((TUNNEL.end - TUNNEL.start) * r) / (mRows - 1);
    frame(d, f);
    const endTaper = sm(0, 14, Math.min(d - TUNNEL.start, TUNNEL.end - d)); // flush with the portal faces
    for (let c = 0; c < mCols; c++) {
      const lat = -MASS_W + (c / (mCols - 1)) * MASS_W * 2;
      const base = massHeight(lat);
      const bump = (Math.sin(lat * 0.33 + d * 0.071) * 1.3 + Math.sin(d * 0.113 + lat * 0.12) * 1.0 + (mRng() - 0.5) * 0.4) * Math.min(1, base / 6) * endTaper;
      const y = c === 0 || c === mCols - 1 ? -8 : base + bump;
      mp.push(f.x + f.rx * lat, f.y + y, f.z + f.rz * lat);
      mc.push(0, 0, 0);
    }
  }
  for (let r = 0; r < mRows - 1; r++) for (let c = 0; c < mCols - 1; c++) { const a = r * mCols + c, b = a + 1, c2 = a + mCols, d2 = c2 + 1; mi.push(a, b, c2, b, d2, c2); }
  const massGeo = new THREE.BufferGeometry();
  massGeo.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
  massGeo.setAttribute('color', new THREE.Float32BufferAttribute(mc, 3));
  massGeo.setIndex(mi);
  massGeo.computeVertexNormals();
  const nrm = massGeo.attributes.normal, col = massGeo.attributes.color;
  for (let i = 0; i < nrm.count; i++) { // grass on the gentle top, bare rock on the steep sides
    const slope = 1 - Math.max(0, nrm.getY(i));
    const t = sm(0.12, 0.5, slope);
    const c = grassC.clone().lerp(rockC, t).lerp(darkC, sm(0.5, 0.9, slope) * 0.6);
    const v = 0.9 + 0.2 * Math.sin(mp[i * 3] * 0.17 + mp[i * 3 + 2] * 0.21);
    col.setXYZ(i, c.r * v, c.g * v, c.b * v);
  }
  const mass = new THREE.Mesh(massGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96 }));
  mass.castShadow = mass.receiveShadow = true;
  group.add(mass);

  // name plate over the entrance
  const sign = makeSign('ROCK TUNNEL', { w: 512, h: 96, bg: '#1a3a5c', fg: '#ffffff', border: '#e8eef5', size: 0.55 });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.98), new THREE.MeshStandardMaterial({ map: sign.texture, roughness: 0.6 }));
  const m = roadBasis(TUNNEL.start - 0.2, { pitch: false });
  plate.applyMatrix4(m);
  plate.rotateY(0); // plane faces +z (backwards along the road, toward riders)
  plate.translateY(ARCH_WALL + ARCH_R * 0.86 + 1.9);
  group.add(plate);
  return group;
}

// ---- covered bridge --------------------------------------------------------------------------------------

export function buildBridge({ anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'bridge';
  const wood = makeWood(anisotropy);
  const woodMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.85 });
  const roofTex = makeRoofTiles(anisotropy);
  roofTex.repeat.set(4, 2);
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.8, side: THREE.DoubleSide });
  const stone = makeStone(anisotropy, 140);
  stone.repeat.set(2, 2);
  const stoneMat = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95 });
  const half = BRIDGE.half;

  // deck planks follow the road
  const deckTex = wood.clone();
  deckTex.repeat.set(1, 1);
  deckTex.needsUpdate = true;
  const deck = new THREE.Mesh(ribbon(BRIDGE.x - half, BRIDGE.x + half, { l0: -5.4, l1: 5.4, y: 0.03, step: 1.5, uvAlong: 3 }),
    new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  deck.receiveShadow = true;
  group.add(deck);

  const local = new THREE.Group();
  local.applyMatrix4(roadBasis(BRIDGE.x));
  group.add(local);

  const L = half * 2 + 1.2; // length along the road
  const parts = [];
  const bed = 6.0;
  // structure below the deck: side beams and abutments
  for (const side of [-1, 1]) {
    parts.push(boxGeo(0.5, 0.9, L, side * 5.2, -0.5, 0));
    parts.push(boxGeo(0.3, 0.3, L, side * 5.5, 1.0, 0)); // lower rail
    parts.push(boxGeo(0.3, 0.3, L, side * 5.5, 1.55, 0));
    parts.push(boxGeo(0.34, 0.22, L, side * 5.5, 2.15, 0));
  }
  const posts = [];
  for (let z = -half; z <= half + 0.01; z += 4.5) {
    for (const side of [-1, 1]) posts.push(boxGeo(0.38, 6.4, 0.38, side * 5.45, 3.2, z));
    posts.push(boxGeo(11.4, 0.34, 0.34, 0, 6.2, z)); // tie beam
    for (const side of [-1, 1]) {
      const brace = boxGeo(0.22, 1.9, 0.22, side * 4.7, 5.2, z);
      brace.rotateZ(side * 0.62);
      posts.push(brace);
    }
  }
  const woodGeo = mergeGeometries([...parts, ...posts]);
  const frameMesh = new THREE.Mesh(woodGeo, woodMat);
  frameMesh.castShadow = true; frameMesh.receiveShadow = true;
  local.add(frameMesh);

  // stone approaches: solid abutments that run down to the stream bed and carry the road onto the bridge
  for (const sgn of [-1, 1]) {
    const len = 7.5;
    const ab = new THREE.Mesh(new THREE.BoxGeometry(11.9, bed + 3, len), stoneMat);
    ab.position.set(0, -(bed + 3) / 2 - 0.06, sgn * (half + 0.2 + len / 2));
    ab.castShadow = ab.receiveShadow = true;
    local.add(ab);
  }

  // gabled roof
  const roofW = 6.5;
  const ridgeY = 8.6, eaveY = 6.3;
  const rp = [];
  const ruv = [];
  const quad = (a, b, c, d) => { rp.push(...a, ...b, ...c, ...a, ...c, ...d); ruv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1); };
  quad([-roofW, eaveY, -half - 0.8], [0, ridgeY, -half - 0.8], [0, ridgeY, half + 0.8], [-roofW, eaveY, half + 0.8]);
  quad([0, ridgeY, -half - 0.8], [roofW, eaveY, -half - 0.8], [roofW, eaveY, half + 0.8], [0, ridgeY, half + 0.8]);
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
  roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
  roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.castShadow = true;
  local.add(roof);
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, L + 1.2), woodMat);
  ridge.position.set(0, ridgeY + 0.1, 0);
  local.add(ridge);
  // gable ends
  const gable = new THREE.Shape();
  gable.moveTo(-roofW + 0.5, eaveY); gable.lineTo(0, ridgeY); gable.lineTo(roofW - 0.5, eaveY); gable.lineTo(-roofW + 0.5, eaveY);
  const gGeo = new THREE.ShapeGeometry(gable);
  for (const z of [-half - 0.78, half + 0.78]) {
    const g = new THREE.Mesh(gGeo, woodMat);
    g.position.z = z;
    if (z > 0) g.rotation.y = 0; else g.rotation.y = Math.PI;
    g.material = woodMat;
    local.add(g);
  }

  // hanging lanterns
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd58a').multiplyScalar(2.2), toneMapped: false });
  for (let z = -half + 2; z < half; z += 4.5) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), lampMat);
    lamp.position.set(0, 5.4, z);
    local.add(lamp);
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.8, 4), woodMat);
    chain.position.set(0, 5.85, z);
    local.add(chain);
  }
  return group;
}
