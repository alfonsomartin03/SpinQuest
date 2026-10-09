// The course in 3D world space. World axes: x = east, y = up, z = south (so the course's map y maps to -z).
// A road frame at distance d gives position, tangent and right vectors, with the elevation exaggerated a
// little so hills read well from the saddle.

import { LOOP, posAt, elevation, headingAt } from '../course.js';

export const VEX = 1.6; // vertical exaggeration of the road profile
export const BASE_ALT = 1180; // altitude (m) of world y = 0

export { LOOP };
export const elevEx = (d) => (elevation(d) - BASE_ALT) * VEX;

const STEP = 1; // table spacing (m)
const N = LOOP / STEP;
const TX = new Float32Array(N + 1);
const TZ = new Float32Array(N + 1);
const TY = new Float32Array(N + 1);
const TT = new Float32Array(N + 1); // heading (rad), wrapped to the lap

(() => {
  for (let i = 0; i <= N; i++) {
    const d = i * STEP;
    const p = posAt(d % LOOP);
    TX[i] = p.x;
    TZ[i] = -p.y;
    TY[i] = elevEx(d);
    TT[i] = headingAt(d); // unwrapped, so the last entry carries a full turn and interpolation stays smooth
  }
})();

const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

/** Road frame at distance d (wraps around the loop). Writes into `out` if given. */
export function frame(d, out = {}) {
  const p = wrap(d) / STEP;
  const i = Math.floor(p);
  const f = p - i;
  const j = i + 1 > N ? N : i + 1;
  out.x = TX[i] + (TX[j] - TX[i]) * f;
  out.z = TZ[i] + (TZ[j] - TZ[i]) * f;
  out.y = TY[i] + (TY[j] - TY[i]) * f;
  const th = TT[i] + (TT[j] - TT[i]) * f;
  out.theta = th;
  out.tx = Math.cos(th); // tangent in world xz
  out.tz = -Math.sin(th);
  out.rx = Math.sin(th); // right of travel
  out.rz = Math.cos(th);
  out.grade = (TY[Math.min(N, i + 4)] - TY[Math.max(0, i - 3)]) / 7; // exaggerated slope, rise/run
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

// bounding box of the loop in world space
export const BOUNDS = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < N; i += 5) { minX = Math.min(minX, TX[i]); maxX = Math.max(maxX, TX[i]); minZ = Math.min(minZ, TZ[i]); maxZ = Math.max(maxZ, TZ[i]); }
  return { minX, maxX, minZ, maxZ };
})();
