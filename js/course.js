// The world: a 10 km closed loop with real map geometry, an elevation profile, themed zones,
// landmarks and timed segments, plus an optional 10 km flat extension that leaves the loop at a turn point and comes
// back to the same spot. Everything is a pure function of a course coordinate `c`:
//   c in [0, LOOP)        the main loop (any other value wraps around it, so lap counts can be passed straight in)
//   c in [LOOP, TOTAL]    the extension, LOOP + metres since the turn point

export const LOOP = 10000; // metres
export const SPUR_LEN = 10000; // metres of extension
export const TOTAL = LOOP + SPUR_LEN;
export const JUNCTION = 9900; // where the turn point sits on the loop (metres), just before the start line
const DS = 5; // path sample spacing (m)
const N = LOOP / DS;
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;
/** True for course coordinates on the extension. */
export const onSpur = (c) => c >= LOOP && c <= TOTAL;

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
const mainCurvature = (d) => tab(kappa, d);
/** Compass heading in radians, unwrapped so it keeps counting across laps. */
function mainHeading(d) {
  const lap = Math.floor(d / LOOP);
  const p = (d - lap * LOOP) / DS;
  const i = Math.floor(p);
  const f = p - i;
  const t1 = i + 1 >= N ? theta[0] + TURN : theta[i + 1];
  return theta[i] * (1 - f) + t1 * f + lap * TURN;
}
const PX = Float64Array.from(path, (p) => p[0]);
const PY = Float64Array.from(path, (p) => p[1]);
const mainPos = (d) => ({ x: tab(PX, d), y: tab(PY, d) });

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

function mainElevation(d) {
  const p = wrap(d);
  const i = Math.floor(p);
  return ELEV[i] + (ELEV[i + 1] - ELEV[i]) * (p - i);
}
const mainGrade = (d) => (mainElevation(d + 6) - mainElevation(d - 6)) / 12;

// ---- The extension ---------------------------------------------------------------------------------------
// A closed, smooth loop that touches the main road at the turn point with the same heading, so a rider can follow either
// without any jump in position or direction. It bulges away to the right of the road (outside the main loop) and is
// rescaled to be exactly SPUR_LEN long. Its profile is nearly flat: it follows the road's own profile for the first
// and last few hundred metres (so the two roads meet at the same height) and rolls gently in between.

const SPUR = (() => {
  const jp = mainPos(JUNCTION), th = mainHeading(JUNCTION);
  const t = [Math.cos(th), Math.sin(th)], r = [Math.cos(th - Math.PI / 2), Math.sin(th - Math.PI / 2)];
  const A = 2000, B = 1000; // ellipse half-axes (away from the road, along it); only the proportions matter
  const shape = (u) => 1 + 0.08 * Math.sin(2 * u + 0.9) + 0.05 * Math.sin(3 * u + 2.1) + 0.03 * Math.sin(5 * u); // 1-periodic wobble
  const at = (u, k) => {
    const w = shape(u) * k;
    return [jp.x + w * A * (1 - Math.cos(u)) * r[0] + w * B * Math.sin(u) * t[0], jp.y + w * A * (1 - Math.cos(u)) * r[1] + w * B * Math.sin(u) * t[1]];
  };
  // arc length of the unscaled curve, then scale it (about the turn point) to the length we want
  const M = 40000;
  let len = 0, prev = at(0, 1);
  for (let i = 1; i <= M; i++) { const q = at((i / M) * Math.PI * 2, 1); len += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
  const k = SPUR_LEN / len;
  // resample at DS spacing by arc length
  const dense = Array.from({ length: M + 1 }, (_, i) => at((i / M) * Math.PI * 2, k));
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const n = SPUR_LEN / DS;
  const X = new Float64Array(n + 1), Y = new Float64Array(n + 1);
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * cum[M];
    while (j < M - 1 && cum[j + 1] <= target) j++;
    const f = (target - cum[j]) / (cum[j + 1] - cum[j] || 1);
    X[i] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f;
    Y[i] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f;
  }
  // heading (unwrapped, starting from the road's heading) and curvature
  const th2 = new Float64Array(n + 1);
  const tan = (i) => { const a = Math.max(0, i - 1), b = Math.min(n, i + 1); return [X[b] - X[a], Y[b] - Y[a]]; };
  th2[0] = th;
  let prevT = tan(0);
  for (let i = 1; i <= n; i++) {
    const cur = tan(i);
    th2[i] = th2[i - 1] + angle(prevT, cur);
    prevT = cur;
  }
  th2[0] = th;
  const kap = Float64Array.from({ length: n + 1 }, (_, i) => {
    const a = Math.max(0, i - 3), b = Math.min(n, i + 3);
    return (th2[b] - th2[a]) / ((b - a) * DS);
  });
  // elevation. Where the two roads run side by side they must sit at exactly the same height, so near the turn point the
  // extension takes the height of whichever point of the road is closest to it, not of the same distance along.
  const BLEND = 450;
  const xyAt = (sp) => {
    const p = sp / DS, i = Math.min(n - 1, Math.floor(p)), f = p - i;
    return [X[i] + (X[i + 1] - X[i]) * f, Y[i] + (Y[i + 1] - Y[i]) * f];
  };
  const roadHeightBeside = (sp, lo, hi) => {
    const [px, py] = xyAt(sp);
    let best = Infinity, bd = lo;
    for (let d = lo; d <= hi; d += 0.5) {
      const q = mainPos(d), dd = (q.x - px) ** 2 + (q.y - py) ** 2;
      if (dd < best) { best = dd; bd = d; }
    }
    return mainElevation(bd);
  };
  const eStart = Float64Array.from({ length: BLEND + 1 }, (_, q) => roadHeightBeside(q, JUNCTION - 40, JUNCTION + BLEND + 150));
  const eEnd = Float64Array.from({ length: BLEND + 1 }, (_, q) => roadHeightBeside(SPUR_LEN - q, JUNCTION - BLEND - 150, JUNCTION + 40));
  const lerpAt = (arr, q) => { const i = Math.min(BLEND - 1, Math.floor(q)); return arr[i] + (arr[i + 1] - arr[i]) * (q - i); };
  const lo = eStart[BLEND], hi = eEnd[BLEND];
  const elev = (s) => {
    const q = Math.min(SPUR_LEN, Math.max(0, s));
    const u = (q / SPUR_LEN);
    const mid = lo + (hi - lo) * Math.min(1, Math.max(0, (q - BLEND) / (SPUR_LEN - 2 * BLEND)));
    const window = smooth(Math.min(q, SPUR_LEN - q) / 700);
    const roll = window * (3 * Math.sin(u * Math.PI * 2 * 3.1 + 0.4) + 1 * Math.sin(u * Math.PI * 2 * 7.3 + 1.1) + 0.5 * Math.sin(u * Math.PI * 2 * 30 + 2) + 0.2 * Math.sin(u * Math.PI * 2 * 80));
    const near = (m) => (m <= 150 ? 1 : smooth((BLEND - m) / (BLEND - 150))); // exactly the road's profile where the two roads overlap
    const a = near(q), b = near(SPUR_LEN - q);
    const base = mid * (1 - a - b) + (a ? lerpAt(eStart, Math.min(q, BLEND)) * a : 0) + (b ? lerpAt(eEnd, Math.min(SPUR_LEN - q, BLEND)) * b : 0);
    return base + roll;
  };
  const E = Float64Array.from({ length: SPUR_LEN + 1 }, (_, s) => elev(s));
  return { X, Y, th: th2, kap, n, E };
})();

const spurTab = (arr, s) => {
  const p = Math.min(SPUR.n, Math.max(0, s / DS));
  const i = Math.min(SPUR.n - 1, Math.floor(p));
  return arr[i] * (1 - (p - i)) + arr[i + 1] * (p - i);
};

/** Signed curvature (1/m); positive = turning left. */
export const curvatureAt = (c) => (onSpur(c) ? spurTab(SPUR.kap, c - LOOP) : mainCurvature(c));
/** Heading in radians (anticlockwise from east), unwrapped so it keeps counting across laps and around the extension. */
export const headingAt = (c) => (onSpur(c) ? spurTab(SPUR.th, c - LOOP) : mainHeading(c));
/** Map position in metres: x = east, y = north. */
export const posAt = (c) => (onSpur(c) ? { x: spurTab(SPUR.X, c - LOOP), y: spurTab(SPUR.Y, c - LOOP) } : mainPos(c));
export function elevation(c) {
  if (!onSpur(c)) return mainElevation(c);
  const s = Math.min(SPUR_LEN, Math.max(0, c - LOOP));
  const i = Math.min(SPUR_LEN - 1, Math.floor(s));
  return SPUR.E[i] + (SPUR.E[i + 1] - SPUR.E[i]) * (s - i);
}
export const gradeAt = (c) => {
  if (!onSpur(c)) return mainGrade(c);
  const s = c - LOOP;
  const a = Math.max(0, s - 6), b = Math.min(SPUR_LEN, s + 6);
  return b > a ? (elevation(LOOP + b) - elevation(LOOP + a)) / (b - a) : 0;
};

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
  { id: 'flats', name: 'Prairie Flats', blurb: 'Long, flat and open. Find your rhythm', start: LOOP, end: TOTAL, ground: [168, 176, 92] },
];
export const SPUR_BIOME = BIOMES.length - 1;

export function biomeIndex(c) {
  if (onSpur(c)) return SPUR_BIOME;
  const p = wrap(c);
  return BIOMES.findIndex((b) => p >= b.start && p < b.end);
}

const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Environment at distance d: blended ground colour, snow cover and lake presence. */
export function envAt(c) {
  const spur = onSpur(c);
  const p = spur ? c : wrap(c);
  const i = biomeIndex(p);
  const b = BIOMES[i];
  const B = 220;
  let ground = b.ground;
  const toEnd = b.end - p;
  const fromStart = p - b.start;
  const nextI = spur ? 6 : i === 6 ? 0 : (i + 1) % SPUR_BIOME;
  const prevI = spur ? 6 : (i - 1 + SPUR_BIOME) % SPUR_BIOME;
  if (toEnd < B) ground = mixc(ground, BIOMES[nextI].ground, 0.5 * (1 - toEnd / B));
  else if (fromStart < B) ground = mixc(ground, BIOMES[prevI].ground, 0.5 * (1 - fromStart / B));
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
  { id: 'lighthouse', name: 'Lighthouse', d: 8148, lat: -70, kind: 'lighthouse', emoji: '🗼' },
  { id: 'market', name: 'Market Square', d: 8620, lat: 9, kind: 'market', emoji: '🎪' },
  { id: 'church', name: 'Village Church', d: 8850, lat: -19, kind: 'church', emoji: '⛪' },
  { id: 'windmill2', name: 'Harvest Mill', d: 9750, lat: 20, kind: 'windmill', emoji: '🌾' },
  // on the extension
  { id: 'windfarm', name: 'Prairie Windmills', d: LOOP + 2900, lat: -24, kind: 'windmill', emoji: '💨' },
  { id: 'herd', name: 'Prairie Herd', d: LOOP + 6600, lat: 16, kind: 'cows', emoji: '🐂' },
];

// ---- Lake (shared by the 3D world and the map) -------------------------------------------------------

/** An ellipse on the left of the road, centred `offset` m from the road at distance `d`. */
export const LAKE_SHAPE = { d: 8150, offset: 340, ra: 460, rb: 270 }; // sized and placed so the road never touches the water

// ---- Climbs ---------------------------------------------------------------------------------------------

export const CLIMBS = [
  { id: 'col', name: 'Col de SpinQuest', start: 1500, end: 4600 },
];

const clampN = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Where a rider stands on a climb at distance d: what's left, how steep it is now and what's coming.
 * Elevations and grades are real (not the exaggerated 3D ones).
 */
export function climbStats(climb, d) {
  const p = wrap(d);
  const len = climb.end - climb.start;
  const pos = clampN(p, climb.start, climb.end);
  const into = pos - climb.start;
  const left = len - into;
  const alt0 = elevation(climb.start), alt1 = elevation(climb.end), altNow = elevation(pos);
  const elevLeft = Math.max(0, alt1 - altNow);
  const avgAhead = (m) => { const to = Math.min(climb.end, pos + m); return to - pos > 1 ? (elevation(to) - altNow) / (to - pos) : 0; };
  let steepest = { grade: -1, dist: 0 };
  for (let m = 0; m <= Math.min(1000, left); m += 25) {
    const g = gradeAt(pos + m);
    if (g > steepest.grade) steepest = { grade: g, dist: m };
  }
  return {
    state: p < climb.start ? 'before' : p > climb.end ? 'done' : 'on',
    toStart: Math.max(0, climb.start - p),
    len, into, left,
    progress: into / len,
    elevTotal: alt1 - alt0, elevLeft,
    avgAll: (alt1 - alt0) / len,
    avgLeft: left > 1 ? elevLeft / left : 0,
    gradeNow: gradeAt(pos),
    next500: avgAhead(500),
    next1k: avgAhead(1000),
    steepest,
    summitAlt: alt1,
    altNow,
  };
}

/** The climb the rider is on, or about to start (within `lead` metres), with its stats. */
export function activeClimb(d, lead = 450) {
  if (onSpur(d)) return null;
  const p = wrap(d);
  for (const climb of CLIMBS) {
    if (p >= climb.start - lead && p <= climb.end) return { climb, stats: climbStats(climb, p) };
  }
  return null;
}

/**
 * One entry per complete ascent of `climb` in a ride: the time from the foot to the top and the averages on the way.
 * `samples` are the per-second ride samples ({p, hr, c}); sample i covers second i to i + 1, and `c` is the course
 * coordinate at its end (a sample without one is taken to be on the main loop, wrapped).
 */
export function climbSplits(samples, climb) {
  const out = [];
  let prev = 0, t0 = null, lap = 1;
  const cOf = (s) => s.c ?? wrap(s.d);
  samples.forEach((s, i) => {
    const c = cOf(s);
    if (!onSpur(c)) {
      if (c < prev - LOOP / 2) { lap++; t0 = null; } // wrapped past the start line
      if (prev < climb.start && climb.start <= c && c - prev < 200) t0 = i + (climb.start - prev) / (c - prev);
      if (t0 != null && prev < climb.end && climb.end <= c && c - prev < 200) {
        const t1 = i + (climb.end - prev) / (c - prev);
        const part = samples.slice(Math.floor(t0), Math.ceil(t1));
        const hrs = part.filter((x) => x.hr > 0);
        out.push({
          lap, time: t1 - t0,
          avgPower: part.reduce((a, x) => a + x.p, 0) / part.length,
          avgHr: hrs.length ? hrs.reduce((a, x) => a + x.hr, 0) / hrs.length : null,
          avgSpeed: (climb.end - climb.start) / (t1 - t0),
        });
        t0 = null;
      }
    }
    prev = onSpur(c) ? JUNCTION : c; // out on the extension, the next point on the loop is the turn point again
  });
  return out;
}

// ---- Timed segments ---------------------------------------------------------------------------

export const SEGMENTS = [
  { id: 'kom', name: 'Col Climb', kind: 'climb', start: 2300, end: 4600, color: '#ff4d4d' },
  { id: 'descent', name: 'Switchback Run', kind: 'sprint', start: 4950, end: 5750, color: '#c25cff' },
  { id: 'lake', name: 'Lakeside Sprint', kind: 'sprint', start: 7900, end: 8300, color: '#3ecf6e' },
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

/** The extension's points, and the bounds of the whole course (loop and extension) for the map. */
export const SPUR_MAP = (() => {
  const pts = [];
  for (let s = 0; s <= SPUR_LEN; s += 25) {
    const p = posAt(LOOP + s);
    pts.push({ d: LOOP + s, x: p.x, y: p.y, g: gradeAt(LOOP + s) });
  }
  const xs = pts.map((p) => p.x).concat(MAP.minX, MAP.maxX), ys = pts.map((p) => p.y).concat(MAP.minY, MAP.maxY);
  return { pts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
})();
