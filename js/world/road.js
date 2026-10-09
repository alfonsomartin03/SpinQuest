// The road: a textured ribbon along the course, painted segment bands, reflector posts, snow poles
// and chevron boards on the sharp bends.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOOP, SEGMENTS, TUNNEL, BRIDGE, curvatureAt } from '../course.js';
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

export function buildRoad({ anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'road';

  // surface
  const { map, bump } = makeAsphalt(anisotropy);
  const mat = new THREE.MeshStandardMaterial({
    map, bumpMap: bump, bumpScale: 1.2, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // the deck of the covered bridge replaces the road between its abutments
  const pieces = [[0, BRIDGE.x - BRIDGE.half], [BRIDGE.x + BRIDGE.half, LOOP]];
  for (const [a, b] of pieces) {
    const m = new THREE.Mesh(ribbon(a, b, { y: 0.02 }), mat);
    m.receiveShadow = true;
    group.add(m);
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
  for (let d = 12; d < LOOP; d += 24) {
    const inTunnel = d > TUNNEL.start - 12 && d < TUNNEL.end + 12;
    const onBridge = Math.abs(d - BRIDGE.x) < 20;
    if (inTunnel || onBridge) continue;
    const alpine = d > 3600 && d < 5400;
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
  for (let d = 20; d < LOOP; d += 13) {
    if ((d > TUNNEL.start - 40 && d < TUNNEL.end + 40) || Math.abs(d - BRIDGE.x) < 40) continue;
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
