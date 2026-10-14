// The course in 3D world space. World axes: x = east, y = up, z = south (so the course's map y maps to -z).
// A road frame at distance d gives position, tangent and right vectors, with the elevation exaggerated a
// little so hills read well from the saddle.

import { LOOP, TOTAL, SPURS, posAt, elevation, headingAt, onSpur, spurAt } from '../course.js';

export const VEX = 1.6; // vertical exaggeration of the road profile
export const BASE_ALT = 1180; // altitude (m) of world y = 0

export { LOOP, TOTAL };
export const elevEx = (d) => (elevation(d) - BASE_ALT) * VEX;

const STEP = 1; // table spacing (m)

/** Road tables for one stretch: the main loop (length LOOP) or one of the detours. */
function table(len, base) {
  const n = len / STEP;
  const T = { n, len, x: new Float32Array(n + 1), z: new Float32Array(n + 1), y: new Float32Array(n + 1), t: new Float32Array(n + 1) };
  for (let i = 0; i <= n; i++) {
    const c = Math.min(base + i * STEP, base + len - 1e-6); // the loop's last entry is the start line again, not the extension
    const p = posAt(c);
    T.x[i] = p.x;
    T.z[i] = -p.y;
    T.y[i] = elevEx(c);
    T.t[i] = headingAt(c); // unwrapped, so the last entry carries the full turn and interpolation stays smooth
  }
  return T;
}
const MAIN = table(LOOP, 0);
const SPUR_TABLES = SPURS.map((sp) => table(sp.len, sp.base));

const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

/** Road frame at course coordinate d (see course.js; the main loop wraps). Writes into `out` if given. */
export function frame(d, out = {}) {
  let T, p;
  if (onSpur(d)) { const sp = SPURS[spurAt(d)]; T = SPUR_TABLES[sp.index]; p = Math.min(sp.len, Math.max(0, d - sp.base)) / STEP; } else { T = MAIN; p = wrap(d) / STEP; }
  const i = Math.floor(p);
  const f = p - i;
  const j = i + 1 > T.n ? T.n : i + 1;
  out.x = T.x[i] + (T.x[j] - T.x[i]) * f;
  out.z = T.z[i] + (T.z[j] - T.z[i]) * f;
  out.y = T.y[i] + (T.y[j] - T.y[i]) * f;
  const th = T.t[i] + (T.t[j] - T.t[i]) * f;
  out.theta = th;
  out.tx = Math.cos(th); // tangent in world xz
  out.tz = -Math.sin(th);
  out.rx = Math.sin(th); // right of travel
  out.rz = Math.cos(th);
  out.grade = (T.y[Math.min(T.n, i + 4)] - T.y[Math.max(0, i - 3)]) / 7; // exaggerated slope, rise/run
  return out;
}

/** World position of a point `lat` metres to the right of the road at distance d, `up` metres above it. */
export function place(d, lat = 0, up = 0, out = {}) {
  frame(d, out);
  out.x += out.rx * lat;
  out.z += out.rz * lat;
  out.y += up;
  return out;
}

/**
 * Snap a coordinate to the 10 m lattice the fine terrain mesh is built on, half a cell in. The lattice belongs to the world, not
 * to the course's bounding box, so adding or moving a road never shifts the mesh under the roads that were already there.
 */
export const snapToLattice = (v, cell = 10) => Math.floor(v / cell) * cell + cell / 2;

// bounding box of the loop (and of the whole course, with the extension) in world space
const boxOf = (tables) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const T of tables) {
    for (let i = 0; i < T.n; i += 5) { minX = Math.min(minX, T.x[i]); maxX = Math.max(maxX, T.x[i]); minZ = Math.min(minZ, T.z[i]); maxZ = Math.max(maxZ, T.z[i]); }
  }
  return { minX, maxX, minZ, maxZ };
};
export const LOOP_BOUNDS = boxOf([MAIN]);
export const BOUNDS = boxOf([MAIN, ...SPUR_TABLES]);
