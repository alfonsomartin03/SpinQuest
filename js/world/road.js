// The road: a textured ribbon along the course, painted segment bands, reflector posts, snow poles
// and chevron boards on the sharp bends.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOOP, SPURS, SEGMENTS, TUNNEL, BRIDGE, curvatureAt, elevation } from '../course.js';
import { frame } from './geo.js';
import { makeAsphalt, makeChevron } from './textures.js';

export const ROAD_HALF = 4.5; // drivable half width (m)
export const SHOULDER = 5.8; // half width of the textured strip

/** A strip along the road between lateral offsets l0..l1 (m, + = right), from distance d0 to d1. */
export function ribbon(d0, d1, { step = 2, l0 = -SHOULDER, l1 = SHOULDER, y = 0, uvAlong = 12 } = {}) {
  const rows = Math.max(2, Math.ceil((d1 - d0) / step) + 1);
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const f = {};
  for (let r = 0; r < rows; r++) {
    const d = d0 + ((d1 - d0) * r) / (rows - 1);
    frame(d, f);
    for (let k = 0; k < 2; k++) {
      const lat = k ? l1 : l0;
      const i = (r * 2 + k) * 3;
      pos[i] = f.x + f.rx * lat; pos[i + 1] = f.y + y; pos[i + 2] = f.z + f.rz * lat;
      uv[(r * 2 + k) * 2] = k; uv[(r * 2 + k) * 2 + 1] = d / uvAlong;
    }
  }
  const idx = new Uint32Array((rows - 1) * 6);
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.set([a, b, c, b, d, c], r * 6); // counter-clockwise seen from above
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

/** Orient an object lying on the road at d, `lat` metres to the right, facing along (or across) the road. */
export function roadMatrix(d, lat, up, { yaw = 0, scale = 1 } = {}) {
  const f = frame(d);
  const m = new THREE.Matrix4();
  const fwd = new THREE.Vector3(f.tx, 0, f.tz);
  const upv = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(fwd, upv);
  m.makeBasis(fwd, upv, right);
  if (yaw) m.multiply(new THREE.Matrix4().makeRotationY(yaw));
  m.setPosition(f.x + f.rx * lat, f.y + up, f.z + f.rz * lat);
  if (scale !== 1) m.scale(new THREE.Vector3(scale, scale, scale));
  return m;
}

function instanced(geometry, material, matrices) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

const box = (w, h, d, x, y, z, color) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
};

// Where a detour leaves or rejoins the loop the two roads overlap for a while, and the loop's surface is drawn over the detour's.
// Anything that stands beside the road (neon rails, posts, boards) is held back until the roads have parted, or it would
// cut across the other road's lanes.
const JOIN = 400; // how far from the fork or rejoin the roads can still overlap
const _fa = {}, _fb = {};
const wrapLoop = (d) => ((d % LOOP) + LOOP) % LOOP;
/** True when the road at course distance d is at least `sep` metres (centreline to centreline) from the road it merges with. */
function parted(d, sep) {
  for (const sp of SPURS) {
    let other = null;
    if (d < LOOP) {
      if (d >= sp.fork && d < sp.fork + JOIN) other = sp.base + (d - sp.fork);
      else if (d > sp.rejoin - JOIN && d <= sp.rejoin) other = sp.end - (sp.rejoin - d);
    } else if (d >= sp.base && d <= sp.end) {
      if (d - sp.base < JOIN) other = sp.fork + (d - sp.base);
      else if (sp.end - d < JOIN) other = sp.rejoin - (sp.end - d);
    }
    if (other == null) continue;
    frame(d, _fa);
    frame(other < LOOP ? wrapLoop(other) : other, _fb);
    if (Math.hypot(_fa.x - _fb.x, _fa.z - _fb.z) < sep) return false;
  }
  return true;
}

const LOOP_TILE = LOOP / Math.round(LOOP / 12); // a whole number of lane-marking tiles round the loop, so the dashes run unbroken over the start line

export function buildRoad({ anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'road';

  // surface
  const { map, bump } = makeAsphalt(anisotropy);
  const mat = new THREE.MeshStandardMaterial({
    map, bumpMap: bump, bumpScale: 0.6, roughness: 0.5, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // the deck of the covered bridge replaces the road between its abutments
  const pieces = [[0, BRIDGE.x - BRIDGE.half], [BRIDGE.x + BRIDGE.half, LOOP - 1e-3]];
  for (const [a, b] of pieces) {
    const m = new THREE.Mesh(ribbon(a, b, { y: 0.02, uvAlong: LOOP_TILE }), mat);
    m.receiveShadow = true;
    group.add(m);
  }
  // the detours: where one shares the road with the loop at its fork or rejoin, the loop's surface wins, so there is one set
  // of lane markings there and the detour's emerges from underneath as the roads part
  const spurMat = mat.clone();
  spurMat.polygonOffsetFactor = spurMat.polygonOffsetUnits = -1;
  for (const sp of SPURS) {
    const spur = new THREE.Mesh(ribbon(sp.base, sp.end, { y: 0.008 }), spurMat); // a hair lower than the loop, so the two never z-fight where they overlap
    spur.receiveShadow = true;
    group.add(spur);
  }
  // every stretch of road that gets posts and chevrons: the loop, then each detour
  const spans = [[0, LOOP], ...SPURS.map((sp) => [sp.base, sp.end])];

  // glowing neon edge rails: arena blue down the left of the road, orange down the right, so the course reads like a track
  const railPieces = (from, to) => {
    const cuts = [[TUNNEL.start - 6, TUNNEL.end + 6], [BRIDGE.x - BRIDGE.half - 2, BRIDGE.x + BRIDGE.half + 2]].filter(([a, b]) => b > from && a < to).sort((p, q) => p[0] - q[0]);
    const out = [];
    let at = from;
    for (const [a, b] of cuts) { if (a > at) out.push([at, a]); at = Math.max(at, b); }
    if (at < to) out.push([at, to]);
    return out;
  };
  const rails = [[-4.78, -4.62, '#18b4ff'], [4.62, 4.78, '#ff7a18']];
  for (const [l0, l1, hex] of rails) {
    const railMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(2.4), toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const geos = [];
    for (const [from, to] of [[0, LOOP - 1e-3], ...SPURS.map((sp) => [sp.base, sp.end])]) { // frame(LOOP) is the start of the first detour, so stop just short of it
      for (const [a, b] of railPieces(from, to)) {
        if (a < LOOP) { if (b - a > 1) geos.push(ribbon(a, b, { l0, l1, y: 0.045, step: 3 })); continue; }
        // a detour's rails start where it has left the loop's road and end where it comes back to it
        let start = null;
        for (let d = a; d <= b + 1e-6; d += 3) {
          const ok = d <= b && parted(d, 11.6);
          if (ok && start == null) start = d;
          if (!ok && start != null) { if (d - 3 - start > 6) geos.push(ribbon(start, d - 3, { l0, l1, y: 0.045, step: 3 })); start = null; }
        }
        if (start != null && b - start > 6) geos.push(ribbon(start, b, { l0, l1, y: 0.045, step: 3 }));
      }
    }
    group.add(new THREE.Mesh(mergeGeometries(geos), railMat));
  }

  // painted segment bands along both shoulders
  for (const s of SEGMENTS) {
    const col = new THREE.Color(s.color);
    const bandMat = new THREE.MeshBasicMaterial({ color: col, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, transparent: true, opacity: 0.75 });
    for (const [l0, l1] of [[-5.5, -5.05], [5.05, 5.5]]) {
      const m = new THREE.Mesh(ribbon(s.start, s.end, { l0, l1, y: 0.04, step: 3 }), bandMat);
      group.add(m);
    }
  }

  // reflector posts every 24 m (skip the tunnel and bridge)
  const postGeo = mergeGeometries([box(0.1, 0.95, 0.1, 0, 0.475, 0, '#f2f2f0'), box(0.105, 0.16, 0.105, 0, 0.62, 0, '#d8322d')]);
  const postMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const polesGeo = mergeGeometries([box(0.09, 2.3, 0.09, 0, 1.15, 0, '#f4f4f2'), box(0.095, 0.5, 0.095, 0, 2.05, 0, '#d8322d'), box(0.1, 0.12, 0.1, 0, 1.35, 0, '#d8322d')]);
  const posts = [], poles = [];
  for (const [from, to] of spans) for (let d = from + 12; d < to; d += 24) {
    const inTunnel = d > TUNNEL.start - 12 && d < TUNNEL.end + 12;
    const onBridge = Math.abs(d - BRIDGE.x) < 20;
    if (inTunnel || onBridge) continue;
    if (!parted(d, 14)) continue;
    const alpine = (d > 3600 && d < 5400) || (d >= LOOP && elevation(d) > 1450); // snow poles on the pass and the top of Death Road
    for (const side of [-1, 1]) {
      if (alpine) poles.push(roadMatrix(d, side * 6.5, 0));
      else posts.push(roadMatrix(d, side * 6.2, 0));
    }
  }
  group.add(instanced(postGeo, postMat, posts));
  group.add(instanced(polesGeo, postMat, poles));

  // chevron boards on tight bends, on the outside of the curve
  const chevTex = makeChevron();
  const boardMat = new THREE.MeshStandardMaterial({ map: chevTex, roughness: 0.5 });
  const postOnly = new THREE.MeshStandardMaterial({ color: '#8a8d92', roughness: 0.5 });
  const boardGeo = new THREE.BoxGeometry(1.2, 0.9, 0.05);
  boardGeo.translate(0, 1.6, 0);
  const stickGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.7, 6);
  stickGeo.translate(0, 0.85, 0);
  const boards = [], sticks = [];
  for (const [from, to] of spans) for (let d = from + 20; d < to; d += 13) {
    if ((d > TUNNEL.start - 40 && d < TUNNEL.end + 40) || Math.abs(d - BRIDGE.x) < 40 || !parted(d, 16)) continue;
    const k = curvatureAt(d);
    if (Math.abs(k) < 0.0042) continue;
    const outside = k > 0 ? 1 : -1; // left bend (k>0): outside is on the right
    const m = roadMatrix(d, outside * 7.4, 0); // the board's face points across the road
    boards.push(m);
    sticks.push(m);
  }
  if (boards.length) {
    group.add(instanced(boardGeo, boardMat, boards));
    group.add(instanced(stickGeo, postOnly, sticks));
  }
  return group;
}
