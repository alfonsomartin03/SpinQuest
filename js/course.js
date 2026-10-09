// The world: a 10 km closed loop with real map geometry, an elevation profile, themed zones,
// landmarks and timed segments. Everything is a pure function of distance along the loop.

export const LOOP = 10000; // metres
const DS = 5; // path sample spacing (m)
const N = LOOP / DS;
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

// ---- Map geometry ---------------------------------------------------------------------
// Waypoints in km; the loop is a closed Catmull-Rom spline rescaled to exactly LOOP metres.

const WAYPOINTS = [
  [0.0, 0.0], [0.8, -0.15], [1.6, 0.05], [2.2, 0.5], [2.4, 1.1], [2.1, 1.6], [2.5, 2.1], [2.0, 2.6],
  [1.2, 2.5], [0.6, 2.8], [0.0, 2.3], [-0.5, 1.8], [-0.4, 1.2], [-0.8, 0.7], [-0.4, 0.3],
];

const catmull = (a, b, c, d, t) =>
  0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);

const path = (() => {
  const n = WAYPOINTS.length;
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p = [-1, 0, 1, 2].map((k) => WAYPOINTS[(i + k + n) % n]);
    for (let s = 0; s < 100; s++) {
      const t = s / 100;
      dense.push([catmull(p[0][0], p[1][0], p[2][0], p[3][0], t), catmull(p[0][1], p[1][1], p[2][1], p[3][1], t)]);
    }
  }
  const m = dense.length;
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const total = cum[m - 1] + Math.hypot(dense[0][0] - dense[m - 1][0], dense[0][1] - dense[m - 1][1]);
  const k = LOOP / total; // km -> metres, so the loop is exactly LOOP long
  const pts = [];
  let j = 0;
  for (let s = 0; s < N; s++) {
    const target = (s * DS) / k;
    while (j < m - 1 && cum[j + 1] <= target) j++;
    const a = dense[j];
    const b = dense[(j + 1) % m];
    const segLen = (j < m - 1 ? cum[j + 1] : total) - cum[j];
    const f = (target - cum[j]) / segLen;
    pts.push([(a[0] + (b[0] - a[0]) * f) * k, (a[1] + (b[1] - a[1]) * f) * k]);
  }
  return pts;
})();

const tangents = path.map((_, i) => {
  const a = path[(i - 1 + N) % N];
  const b = path[(i + 1) % N];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
});
const angle = (u, v) => Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);

const theta = new Float64Array(N);
theta[0] = Math.atan2(tangents[0][1], tangents[0][0]);
for (let i = 1; i < N; i++) theta[i] = theta[i - 1] + angle(tangents[i - 1], tangents[i]);
const TURN = theta[N - 1] - theta[0] + angle(tangents[N - 1], tangents[0]); // ±2π around the loop

const kappa = (() => {
  let k = Float64Array.from({ length: N }, (_, i) => angle(tangents[(i - 1 + N) % N], tangents[(i + 1) % N]) / (2 * DS));
  for (let pass = 0; pass < 3; pass++) {
    k = Float64Array.from(k, (_, i) => (k[(i - 2 + N) % N] + k[(i - 1 + N) % N] + k[i] + k[(i + 1) % N] + k[(i + 2) % N]) / 5);
  }
  return k;
})();

const tab = (arr, d) => {
  const p = wrap(d) / DS;
  const i = Math.floor(p);
  const f = p - i;
  return arr[i] * (1 - f) + arr[(i + 1) % N] * f;
};

/** Signed curvature (1/m); positive = turning left. */
export const curvatureAt = (d) => tab(kappa, d);
/** Compass heading in radians, unwrapped so it keeps counting across laps. */
export function headingAt(d) {
  const lap = Math.floor(d / LOOP);
  const p = (d - lap * LOOP) / DS;
  const i = Math.floor(p);
  const f = p - i;
  const t1 = i + 1 >= N ? theta[0] + TURN : theta[i + 1];
  return theta[i] * (1 - f) + t1 * f + lap * TURN;
}
const PX = Float64Array.from(path, (p) => p[0]);
const PY = Float64Array.from(path, (p) => p[1]);
export const posAt = (d) => ({ x: tab(PX, d), y: tab(PY, d) });

// ---- Elevation -------------------------------------------------------------------------
// Altitude keyframes (distance m, altitude m), smoothed with a periodic cubic Hermite spline.

const KEYS = [
  [0, 1180], [900, 1192], [1500, 1190], [2250, 1237], [3000, 1284], [3750, 1331], [4200, 1358], [4600, 1374],
  [5000, 1366], [5700, 1328], [6400, 1285], [7100, 1240], [7800, 1226], [8500, 1214], [9200, 1203], [9700, 1190],
];

const ELEV = (() => {
  const n = KEYS.length;
  // distance-weighted tangents
  const tan = KEYS.map((_, i) => {
    const a = KEYS[(i - 1 + n) % n];
    const b = KEYS[(i + 1) % n];
    const da = i === 0 ? KEYS[0][0] + LOOP - KEYS[n - 1][0] : KEYS[i][0] - a[0];
    const db = i === n - 1 ? LOOP + KEYS[0][0] - KEYS[i][0] : b[0] - KEYS[i][0];
    const sl = (KEYS[i][1] - a[1]) / da;
    const sr = (b[1] - KEYS[i][1]) / db;
    return (sl * db + sr * da) / (da + db);
  });
  const out = new Float64Array(LOOP + 1);
  for (let d = 0; d < LOOP; d++) {
    let i = n - 1;
    for (let k = 0; k < n; k++) if (KEYS[k][0] > d) { i = k - 1; break; }
    if (i < 0) i = n - 1;
    const j = (i + 1) % n;
    const d0 = KEYS[i][0];
    const d1 = j === 0 ? KEYS[0][0] + LOOP : KEYS[j][0];
    const dd = d >= d0 ? d : d + LOOP;
    const h = d1 - d0;
    const t = (dd - d0) / h;
    const t2 = t * t, t3 = t2 * t;
    const base = (2 * t3 - 3 * t2 + 1) * KEYS[i][1] + (t3 - 2 * t2 + t) * h * tan[i] + (-2 * t3 + 3 * t2) * KEYS[j][1] + (t3 - t2) * h * tan[j];
    const w = (Math.PI * 2 * d) / LOOP;
    out[d] = base + 0.55 * Math.sin(30 * w + 1) + 0.25 * Math.sin(80 * w + 2); // gentle road roll
  }
  out[LOOP] = out[0];
  return out;
})();

export function elevation(d) {
  const p = wrap(d);
  const i = Math.floor(p);
  return ELEV[i] + (ELEV[i + 1] - ELEV[i]) * (p - i);
}
export const gradeAt = (d) => (elevation(d + 6) - elevation(d - 6)) / 12;

export const START = 0;

// ---- Zones (biomes) -----------------------------------------------------------------

export const BIOMES = [
  { id: 'meadow', name: 'Sunny Meadow', blurb: 'Rolling pasture and wildflowers', start: 0, end: 1500, ground: [62, 160, 74] },
  { id: 'forest', name: 'Pine Forest', blurb: 'Cool shade. The climb begins', start: 1500, end: 3300, ground: [36, 104, 62] },
  { id: 'alpine', name: 'Alpine Pass', blurb: 'Rock, snow and thin air', start: 3300, end: 5200, ground: [112, 122, 110] },
  { id: 'descent', name: 'Orchard Descent', blurb: 'Fast sweeping bends', start: 5200, end: 6900, ground: [78, 140, 72] },
  { id: 'lake', name: 'Blue Lake', blurb: 'Smooth road along the water', start: 6900, end: 8300, ground: [92, 150, 84] },
  { id: 'village', name: 'Old Village', blurb: 'Crowds, cobbles and cafes', start: 8300, end: 9500, ground: [96, 152, 84] },
  { id: 'fields', name: 'Golden Fields', blurb: 'Last push through the harvest', start: 9500, end: 10000, ground: [200, 172, 82] },
];

export function biomeIndex(d) {
  const p = wrap(d);
  return BIOMES.findIndex((b) => p >= b.start && p < b.end);
}

const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Environment at distance d: blended ground colour, snow cover and lake presence. */
export function envAt(d) {
  const p = wrap(d);
  const i = biomeIndex(p);
  const b = BIOMES[i];
  const B = 220;
  let ground = b.ground;
  const toEnd = b.end - p;
  const fromStart = p - b.start;
  if (toEnd < B) ground = mixc(ground, BIOMES[(i + 1) % BIOMES.length].ground, 0.5 * (1 - toEnd / B));
  else if (fromStart < B) ground = mixc(ground, BIOMES[(i - 1 + BIOMES.length) % BIOMES.length].ground, 0.5 * (1 - fromStart / B));
  const alt = elevation(p);
  const snow = smooth((alt - 1320) / 35) * (p > 3300 && p < 5300 ? 1 : 0);
  ground = mixc(ground, [238, 243, 250], snow * 0.92);
  const water = smooth((p - 6900) / 250) * smooth((8450 - p) / 250);
  return { biome: i, ground, snow, water, name: b.name };
}

// ---- Special structures ------------------------------------------------------------------

export const TUNNEL = { start: 3400, end: 3660 };
export const BRIDGE = { x: 7020, half: 9 };

// ---- Landmarks ------------------------------------------------------------------------------

export const LANDMARKS = [
  { id: 'start', name: 'Start / Finish', d: 0, lat: 0, kind: 'arch', emoji: '🏁' },
  { id: 'windmill1', name: 'Old Windmill', d: 850, lat: -20, kind: 'windmill', emoji: '🌀' },
  { id: 'cows', name: 'Cow Pasture', d: 1250, lat: 13, kind: 'cows', emoji: '🐄' },
  { id: 'cabin', name: 'Logger Cabin', d: 2150, lat: 17, kind: 'cabin', emoji: '🛖' },
  { id: 'tunnel', name: 'Rock Tunnel', d: 3400, lat: 0, kind: 'tunnel', emoji: '🚇' },
  { id: 'summit', name: 'Summit 1,374 m', d: 4600, lat: 0, kind: 'summit', emoji: '🏔️' },
  { id: 'castle', name: 'Hilltop Castle', d: 5900, lat: 95, kind: 'castle', emoji: '🏰' },
  { id: 'bridge', name: 'Covered Bridge', d: 7020, lat: 0, kind: 'bridge', emoji: '🌉' },
  { id: 'lighthouse', name: 'Lighthouse', d: 7700, lat: -52, kind: 'lighthouse', emoji: '🗼' },
  { id: 'market', name: 'Market Square', d: 8620, lat: 9, kind: 'market', emoji: '🎪' },
  { id: 'church', name: 'Village Church', d: 8850, lat: -19, kind: 'church', emoji: '⛪' },
  { id: 'windmill2', name: 'Harvest Mill', d: 9750, lat: 20, kind: 'windmill', emoji: '🌾' },
];

// ---- Timed segments ---------------------------------------------------------------------------

export const SEGMENTS = [
  { id: 'kom', name: 'Col Climb', kind: 'climb', start: 2300, end: 4600, color: '#ff4d4d' },
  { id: 'descent', name: 'Switchback Run', kind: 'sprint', start: 4950, end: 5750, color: '#c25cff' },
  { id: 'lake', name: 'Lakeside Sprint', kind: 'sprint', start: 7650, end: 8000, color: '#3ecf6e' },
  { id: 'village', name: 'Village Crit', kind: 'sprint', start: 8500, end: 8950, color: '#ff9f2e' },
];

// ---- Minimap data -------------------------------------------------------------------------------

export const MAP = (() => {
  const pts = [];
  for (let d = 0; d <= LOOP; d += 25) {
    const p = posAt(d % LOOP);
    pts.push({ d, x: p.x, y: p.y, g: gradeAt(d) });
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { pts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
})();
