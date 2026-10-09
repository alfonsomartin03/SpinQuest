// Seeded 2D simplex noise plus fractal helpers. Deterministic, so the world is identical every run.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

export function makeNoise(seed = 1337) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  /** Simplex noise in roughly [-1, 1]. */
  const simplex = (x, y) => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { a *= a; const g = GRAD[perm[ii + perm[jj]] & 7]; n += a * a * (g[0] * x0 + g[1] * y0); }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) { a *= a; const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7]; n += a * a * (g[0] * x1 + g[1] * y1); }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) { a *= a; const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7]; n += a * a * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  };

  /** Fractal Brownian motion, ~[-1, 1]. */
  const fbm = (x, y, oct = 5, lac = 2, gain = 0.5) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < oct; o++) { sum += amp * simplex(x * freq, y * freq); norm += amp; amp *= gain; freq *= lac; }
    return sum / norm;
  };

  /** Ridged multifractal, [0, 1]: sharp mountain crests. */
  const ridged = (x, y, oct = 5) => {
    let sum = 0, amp = 0.5, freq = 1, prev = 1;
    for (let o = 0; o < oct; o++) {
      let n = 1 - Math.abs(simplex(x * freq, y * freq));
      n *= n;
      sum += n * amp * prev;
      prev = Math.min(1, n * 1.6);
      amp *= 0.5; freq *= 2.1;
    }
    return Math.min(1, sum * 1.15);
  };

  return { simplex, fbm, ridged, rand };
}

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Cheap deterministic hash of an integer-ish value to [0, 1). */
export const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
export { mulberry32 };
