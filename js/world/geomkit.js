// Small helpers for building low-poly, vertex-coloured geometry: shared by the vegetation (flora.js) and the giant
// surreal scenery (giants.js). Everything here returns plain, non-indexed geometry with a `color` attribute.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise } from './noise.js';

const rngNoise = makeNoise(99);

export const C = (h) => new THREE.Color(h);
export const mixC = (a, b, t) => a.clone().lerp(b, t);

/** Colour a geometry with a bottom-to-top gradient (with a little per-part tint). */
export function paint(geo, bottom, top, tint = 0) {
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

/** Colour a geometry vertex by vertex: `fn(x, y, z)` returns a THREE.Color. */
export function paintBy(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** Move and rotate (Euler, radians) and scale a geometry in place. */
export const xf = (geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx } = {}) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
};

/** An organic blob: an icosahedron with its vertices pushed around by noise. */
export function blob(radius, detail, amp, seed) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + amp * rngNoise.simplex(x * 0.9 + seed, y * 0.9 + z * 0.7 + seed * 1.7);
    p.setXYZ(i, x * n, y * n * 0.92, z * n);
  }
  return g;
}

/** Push every vertex about by smooth noise (metres), so a primitive looks carved rather than turned. Works on indexed geometry. */
export function roughen(geo, amp, freq = 0.12, seed = 0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    p.setXYZ(i, x + amp * rngNoise.simplex(x * freq + seed, y * freq + z * freq * 0.7), y + amp * rngNoise.simplex(y * freq + seed * 1.3, z * freq - x * freq * 0.5), z + amp * rngNoise.simplex(z * freq + seed * 0.7, x * freq + y * freq * 0.4));
  }
  return geo;
}

/** Merge parts (indexed or not) into one geometry. */
export const merge = (parts) => {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingSphere();
  return g;
};
