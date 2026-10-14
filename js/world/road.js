// The road: a cartoon-bright ribbon along the course (built in short chunks so only what is near is drawn), neon edge rails,
// red and white kerbs on the bends, glowing boost pads, painted segment bands, reflector posts and chevron boards.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOOP, SPURS, SEGMENTS, TUNNEL, BRIDGE, curvatureAt, elevation } from '../course.js';
import { frame } from './geo.js';
import { makeAsphalt, makeChevron, makeKerb } from './textures.js';
import { toon } from './toon.js';

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

const CHUNK = 400; // metres of road per mesh

/** Split [from, to] into pieces of at most `size` metres. */
function pieces(from, to, size = CHUNK) {
  const out = [];
  for (let a = from; a < to - 1e-6; a += size) out.push([a, Math.min(a + size, to)]);
  return out;
}

/** Instanced meshes in groups of `per` neighbours, so each group has a small bounding sphere and distant ones are skipped. */
function instancedChunks(geometry, material, matrices, { per = 40, shadow = false, far = 600 } = {}) {
  const g = new THREE.Group();
  for (let i = 0; i < matrices.length; i += per) {
    const part = matrices.slice(i, i + per);
    const mesh = new THREE.InstancedMesh(geometry, material, part.length);
    part.forEach((m, k) => mesh.setMatrixAt(k, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.computeBoundingSphere();
    mesh.userData.far = far;
    g.add(mesh);
  }
  return g;
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
    const parent = sp.parent >= 0 ? SPURS[sp.parent] : null;
    if (d < LOOP) {
      if (!parent && d >= sp.fork && d < sp.fork + JOIN) other = sp.base + (d - sp.fork);
      else if (d > sp.rejoin - JOIN && d <= sp.rejoin) other = sp.end - (sp.rejoin - d);
    } else if (parent && d >= parent.base && d <= parent.end && d >= sp.fork && d < sp.fork + JOIN) {
      other = sp.base + (d - sp.fork); // a road that leaves another detour: that detour, just past the fork
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

/** Paint a geometry one flat (possibly over-bright) colour with a vertex colour attribute. */
function colored(geo, hex, k = 1) {
  const c = new THREE.Color(hex).multiplyScalar(k);
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) { col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** Ranges of course distance in [from, to] where the road bends harder than `k` (1/m), padded a little. */
function bendRanges(from, to, k = 0.003, pad = 14) {
  const out = [];
  let start = null;
  for (let d = from; d <= to; d += 4) {
    const bend = Math.abs(curvatureAt(Math.min(d, to - 1e-3))) > k;
    if (bend && start == null) start = d;
    if (!bend && start != null) { out.push([Math.max(from, start - pad), Math.min(to, d + pad)]); start = null; }
  }
  if (start != null) out.push([Math.max(from, start - pad), to]);
  // merge ranges that nearly touch
  const merged = [];
  for (const r of out) { const l = merged[merged.length - 1]; if (l && r[0] - l[1] < 30) l[1] = r[1]; else merged.push([...r]); }
  return merged.filter(([a, b]) => b - a > 10);
}

/** A glowing, animated chevron panel on the tarmac, like a boost pad. */
function boostPadMaterial(color, uTime) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime, uColor: { value: new THREE.Color(color) } }]),
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vP;
      void main() {
        vP = position.xz / vec2(3.5, 1.3);
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uColor;
      varying vec2 vP;
      void main() {
        float along = vP.x * 0.5 + 0.5;
        float lat = abs(vP.y);
        float c = fract(along * 2.0 - uTime * 1.1 + lat * 0.9);
        float arrow = smoothstep(0.5, 0.55, c) * (1.0 - smoothstep(0.78, 0.83, c)) * step(lat, 0.9) * step(abs(vP.x), 0.9);
        float frame = smoothstep(0.82, 0.95, max(abs(vP.x), lat));
        float shape = max(arrow, frame * 0.9);
        gl_FragColor = vec4(uColor * (0.8 + 3.4 * shape), clamp(0.45 + 0.55 * shape, 0.0, 1.0));
        #include <fog_fragment>
      }`,
    transparent: true, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
}

export function buildRoad({ anisotropy = 8 } = {}) {
  const group = new THREE.Group();
  group.name = 'road';
  const uTime = { value: 0 };
  group.userData.uTime = uTime;

  // surface
  const { map } = makeAsphalt(anisotropy);
  const mat = toon({ map, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  // the deck of the covered bridge replaces the road between its abutments
  const loopPieces = [[0, BRIDGE.x - BRIDGE.half], [BRIDGE.x + BRIDGE.half, LOOP - 1e-3]];
  for (const [from, to] of loopPieces) for (const [a, b] of pieces(from, to)) {
    const m = new THREE.Mesh(ribbon(a, b, { y: 0.02, uvAlong: LOOP_TILE }), mat);
    m.receiveShadow = true;
    m.userData.far = 3000;
    group.add(m);
  }
  // the detours: where one shares the road with the loop at its fork or rejoin, the loop's surface wins, so there is one set
  // of lane markings there and the detour's emerges from underneath as the roads part
  const spurMat = toon({ map, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (const sp of SPURS) for (const [a, b] of pieces(sp.base, sp.end)) {
    const spur = new THREE.Mesh(ribbon(a, b, { y: sp.parent >= 0 ? 0.014 : 0.008 }), spurMat); // a hair lower than the loop, so the two never z-fight where they overlap (and a road that leaves another detour sits a hair above it)
    spur.receiveShadow = true;
    spur.userData.far = 3000;
    group.add(spur);
  }
  // every stretch of road that gets posts and chevrons: the loop, then each detour
  const spans = [[0, LOOP], ...SPURS.map((sp) => [sp.base, sp.end])];
  const roadSpans = [[0, LOOP - 1e-3], ...SPURS.map((sp) => [sp.base, sp.end])]; // frame(LOOP) is the start of the first detour, so stop just short of it

  // glowing neon edge rails: arena blue down the left of the road, orange down the right, so the course reads like a track
  const railPieces = (from, to) => {
    const cuts = [[TUNNEL.start - 6, TUNNEL.end + 6], [BRIDGE.x - BRIDGE.half - 2, BRIDGE.x + BRIDGE.half + 2]].filter(([a, b]) => b > from && a < to).sort((p, q) => p[0] - q[0]);
    const out = [];
    let at = from;
    for (const [a, b] of cuts) { if (a > at) out.push([at, a]); at = Math.max(at, b); }
    if (at < to) out.push([at, to]);
    return out;
  };
  // the stretches of road that get rails: the loop except the tunnel and bridge, and each detour from where it has left the loop's road
  const railRuns = [];
  for (const [from, to] of roadSpans) {
    for (const [a, b] of railPieces(from, to)) {
      if (a < LOOP) { if (b - a > 1) railRuns.push([a, b]); continue; }
      let start = null;
      for (let d = a; d <= b + 1e-6; d += 3) {
        const ok = d <= b && parted(d, 11.6);
        if (ok && start == null) start = d;
        if (!ok && start != null) { if (d - 3 - start > 6) railRuns.push([start, d - 3]); start = null; }
      }
      if (start != null && b - start > 6) railRuns.push([start, b]);
    }
  }
  const railMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  for (const [from, to] of railRuns) for (const [a, b] of pieces(from, to, 600)) {
    const left = colored(ribbon(a, b, { l0: -4.78, l1: -4.62, y: 0.045, step: 4 }), '#18b4ff', 3.4);
    const right = colored(ribbon(a, b, { l0: 4.62, l1: 4.78, y: 0.045, step: 4 }), '#ff7a18', 3.4);
    const rm = new THREE.Mesh(mergeGeometries([left, right]), railMat);
    rm.userData.far = 1100;
    group.add(rm);
  }

  // red and white kerbs on the bends, just outside the rails
  const kerbMat = toon({ map: makeKerb(), polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  for (const [from, to] of roadSpans) for (const [a0, b0] of bendRanges(from, to)) {
    for (const [a, b] of railPieces(a0, b0)) {
      if (b - a < 8 || (a >= LOOP && !(parted(a, 14) && parted(b, 14)))) continue;
      const left = ribbon(a, b, { l0: -5.55, l1: -4.88, y: 0.034, step: 2, uvAlong: 3.6 });
      const right = ribbon(a, b, { l0: 4.88, l1: 5.55, y: 0.034, step: 2, uvAlong: 3.6 });
      const km = new THREE.Mesh(mergeGeometries([left, right]), kerbMat);
      km.userData.far = 900;
      group.add(km);
    }
  }

  // boost pads: a pair of glowing panels, one in each lane, every few hundred metres of open road
  const padGeo = new THREE.PlaneGeometry(7, 2.6);
  padGeo.rotateX(-Math.PI / 2);
  const pads = { left: [], right: [] };
  const clearOfForks = (d) => SPURS.every((sp) => Math.abs(d - sp.fork) > 220 && Math.abs(d - sp.rejoin) > 220);
  for (let d = 340, n = 0; d < LOOP - 120; d += 420, n++) {
    if (d > TUNNEL.start - 60 && d < TUNNEL.end + 60) continue;
    if (Math.abs(d - BRIDGE.x) < 80 || !clearOfForks(d)) continue;
    pads[n % 2 ? 'left' : 'right'].push(roadMatrix(d, n % 2 ? -2.3 : 2.3, 0.05));
  }
  for (const [side, color] of [['left', '#18c8ff'], ['right', '#ff8a1a']]) {
    if (!pads[side].length) continue;
    const g = instancedChunks(padGeo, boostPadMaterial(color, uTime), pads[side], { per: 8, far: 800 });
    group.add(g);
  }

  // painted segment bands along both shoulders
  for (const s of SEGMENTS) {
    const col = new THREE.Color(s.color);
    const bandMat = new THREE.MeshBasicMaterial({ color: col, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, transparent: true, opacity: 0.8 });
    for (const [l0, l1] of [[-5.5, -5.05], [5.05, 5.5]]) for (const [a, b] of pieces(s.start, s.end, 500)) {
      const bm = new THREE.Mesh(ribbon(a, b, { l0, l1, y: 0.04, step: 3 }), bandMat);
      bm.userData.far = 1500;
      group.add(bm);
    }
  }

  // reflector posts every 24 m (skip the tunnel and bridge)
  const postGeo = mergeGeometries([box(0.12, 0.95, 0.12, 0, 0.475, 0, '#ffffff'), box(0.125, 0.18, 0.125, 0, 0.62, 0, '#ff3b30')]);
  const postMat = toon({ vertexColors: true });
  const polesGeo = mergeGeometries([box(0.1, 2.3, 0.1, 0, 1.15, 0, '#ffffff'), box(0.105, 0.5, 0.105, 0, 2.05, 0, '#ff3b30'), box(0.11, 0.12, 0.11, 0, 1.35, 0, '#ff3b30')]);
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
  group.add(instancedChunks(postGeo, postMat, posts, { per: 36, far: 550 }));
  group.add(instancedChunks(polesGeo, postMat, poles, { per: 36, far: 550 }));

  // chevron boards on tight bends, on the outside of the curve
  const chevTex = makeChevron();
  const boardMat = toon({ map: chevTex });
  const postOnly = toon({ color: '#9aa0aa' });
  const boardGeo = new THREE.BoxGeometry(1.2, 0.9, 0.05);
  boardGeo.translate(0, 1.6, 0);
  const stickGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.7, 5, 1, true);
  stickGeo.translate(0, 0.85, 0);
  const boards = [];
  for (const [from, to] of spans) for (let d = from + 20; d < to; d += 13) {
    if ((d > TUNNEL.start - 40 && d < TUNNEL.end + 40) || Math.abs(d - BRIDGE.x) < 40 || !parted(d, 16)) continue;
    const k = curvatureAt(d);
    if (Math.abs(k) < 0.0042) continue;
    const outside = k > 0 ? 1 : -1; // left bend (k>0): outside is on the right
    boards.push(roadMatrix(d, outside * 7.4, 0)); // the board's face points across the road
  }
  if (boards.length) {
    group.add(instancedChunks(boardGeo, boardMat, boards, { per: 24, far: 450 }));
    group.add(instancedChunks(stickGeo, postOnly, boards, { per: 24, far: 450 }));
  }

  // far-away road furniture is too small to see, so hide each chunk once the camera is well past it
  const items = [];
  group.traverse((o) => {
    if (!o.userData.far) return;
    const sph = o.isInstancedMesh ? o.boundingSphere : (o.geometry.boundingSphere ?? (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere));
    items.push([o, sph.center, sph.radius, o.userData.far]);
  });
  group.userData.update = (cam) => { for (const [o, c, r, far] of items) o.visible = Math.hypot(c.x - cam.x, c.z - cam.z) - r < far; };
  return group;
}
