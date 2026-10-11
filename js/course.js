// The world: a 10 km closed loop with real map geometry, an elevation profile, themed zones,
// landmarks and timed segments, plus two detours that leave the loop at a fork and rejoin it further on:
//   Valley Road  forks at the foot of the climb (1.5 km) and rejoins after the descent (6.7 km): flat, around the outside
//   Death Road   forks late in the lap (8 km): a switchback climb at about 8.6% for 20 minutes at 6.5 W/kg, then a long
//                steady descent that comes back onto the loop at the start/finish line
// Everything is a pure function of a course coordinate `c`:
//   c in [0, LOOP)        the main loop (any other value wraps around it, so lap counts can be passed straight in)
//   c in a spur's range   that detour: its `base` plus the metres since its fork (see SPURS; the ranges don't overlap)

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

// ---- Detours off the loop ----------------------------------------------------------------------------------
// Each detour is a smooth road that leaves the loop at its fork and comes back onto it at its rejoin, with the same
// heading and height at both ends, so nothing jumps when you join or leave the loop. Near both ends it follows the loop's
// own profile (so the two roads meet at the same level) and in between it follows its own.

/** Centripetal Catmull-Rom (Barry-Goldman): stays smooth when the way-points are very unevenly spaced. */
function centripetal(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
  const t1 = knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const u = t1 + t * (t2 - t1);
  const mix = (a, b, ta, tb) => [0, 1].map((k) => ((tb - u) * a[k] + (u - ta) * b[k]) / (tb - ta));
  const a1 = mix(p0, p1, 0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2), b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** A smooth open curve through `way`, with the given directions at its two ends. */
function curveThrough(way, startDir, endDir, K = 300, per = 400) {
  const first = way[0], last = way[way.length - 1];
  const ctl = [[first[0] - startDir[0] * K, first[1] - startDir[1] * K], ...way, [last[0] + endDir[0] * K, last[1] + endDir[1] * K]];
  const dense = [];
  for (let i = 1; i < ctl.length - 2; i++) for (let q = 0; q < per; q++) dense.push(centripetal(ctl[i - 1], ctl[i], ctl[i + 1], ctl[i + 2], q / per));
  dense.push(last);
  return dense;
}

/** Straight lines and circular arcs from a starting pose: a switchback road. Returns the points and the final pose. */
function turtlePath(x, y, h) {
  const pts = [[x, y]];
  const line = (L) => { const n = Math.max(1, Math.round(L / 5)); for (let i = 0; i < n; i++) { x += (Math.cos(h) * L) / n; y += (Math.sin(h) * L) / n; pts.push([x, y]); } };
  const arc = (deg, R) => { // negative = a right turn
    const a = (deg * Math.PI) / 180, n = Math.max(2, Math.round((Math.abs(a) * R) / 5));
    for (let i = 0; i < n; i++) { const da = a / n; h += da / 2; x += Math.cos(h) * Math.abs(da) * R; y += Math.sin(h) * Math.abs(da) * R; h += da / 2; pts.push([x, y]); }
  };
  return { pts, line, arc, pose: () => ({ x, y, h }) };
}

/**
 * Build one detour's tables from a dense polyline that runs from its fork to its rejoin.
 * `profile(q, len, ctx)` gives the height of its own profile q metres along (ctx: { forkE, rejoinE }); `roll(u, q, len)` adds the road's texture.
 */
function buildSpur({ fork, rejoin, dense, profile, roll }) {
  const th = mainHeading(fork);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const len = Math.round(cum[cum.length - 1] / DS) * DS; // a whole number of path samples
  const n = len / DS;
  const X = new Float64Array(n + 1), Y = new Float64Array(n + 1);
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (i / n) * cum[cum.length - 1];
    while (j < dense.length - 2 && cum[j + 1] <= target) j++;
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
  // Elevation. Where the two roads run side by side they must sit at exactly the same height, so near the ends the detour
  // takes the height of whichever point of the loop is closest to it, not of the same distance along.
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
  const eStart = Float64Array.from({ length: BLEND + 1 }, (_, q) => roadHeightBeside(q, fork - 40, fork + BLEND + 150));
  const eEnd = Float64Array.from({ length: BLEND + 1 }, (_, q) => roadHeightBeside(len - q, rejoin - BLEND - 150, rejoin + 40));
  const lerpAt = (arr, q) => { const i = Math.min(BLEND - 1, Math.floor(q)); return arr[i] + (arr[i + 1] - arr[i]) * (q - i); };
  const ctx = { forkE: mainElevation(fork), rejoinE: mainElevation(rejoin), lo: eStart[BLEND], hi: eEnd[BLEND] };
  const near = (m) => (m <= 150 ? 1 : smooth((BLEND - m) / (BLEND - 150))); // exactly the road's profile where the two roads overlap
  const elev = (s) => {
    const q = Math.min(len, Math.max(0, s));
    const a = near(q), b = near(len - q);
    const base = profile(q, len, ctx) * (1 - a - b) + (a ? lerpAt(eStart, Math.min(q, BLEND)) * a : 0) + (b ? lerpAt(eEnd, Math.min(len - q, BLEND)) * b : 0);
    const window = smooth((Math.min(q, len - q) - 150) / 550); // no rolls while the two roads overlap
    return base + window * roll(q / len, q, len);
  };
  const E = Float64Array.from({ length: len + 1 }, (_, s) => elev(s));
  return { X, Y, th: th2, kap, n, len, E };
}

const unit = (h) => [Math.cos(h), Math.sin(h)];

// -- Valley Road: flat road around the outside of the climb
const VALLEY = (() => {
  const fork = 1500, rejoin = 6700;
  const jp = mainPos(fork), th = mainHeading(fork), rp = mainPos(rejoin), tr = mainHeading(rejoin);
  const km = (x, y) => [x * 1000, y * 1000];
  const out = unit(th), outRight = unit(th - Math.PI / 2), back = unit(tr), backRight = unit(tr - Math.PI / 2);
  const at = (p, dir, along, right, side) => [p.x + dir[0] * along + side[0] * right, p.y + dir[1] * along + side[1] * right];
  // each end has a point 80 m along the road's own line, so the new road leaves and joins it tangentially, and a point
  // further off to the outside, which is where the two roads part company
  const way = [
    [jp.x, jp.y], at(jp, out, 80, 0, outRight), at(jp, out, 700, 190, outRight), km(2.75, -0.15), km(3.3, 0.55), km(3.6, 1.6),
    km(3.4, 2.7), km(2.65, 3.45), km(1.6, 3.8), km(0.95, 3.6),
    at(rp, back, -650, 230, backRight), at(rp, back, -80, 0, backRight), [rp.x, rp.y],
  ];
  const spur = buildSpur({
    fork, rejoin, dense: curveThrough(way, out, back),
    // nearly flat: it climbs gently from the height of the fork to the height of the rejoin
    profile: (q, len, { lo, hi }) => lo + (hi - lo) * Math.min(1, Math.max(0, (q - 450) / (len - 900))),
    roll: (u) => 2.4 * Math.sin(u * Math.PI * 2 * 3.1 + 0.4) + 0.9 * Math.sin(u * Math.PI * 2 * 7.3 + 1.1) + 0.3 * Math.sin(u * Math.PI * 2 * 30 + 2) + 0.12 * Math.sin(u * Math.PI * 2 * 80),
  });
  return { ...spur, fork, rejoin, id: 'valley', name: 'Valley Road', color: '#3ee0cf' };
})();

/** How far either side of a crossing the upper road is carried on a viaduct (metres). */
export const VIADUCT_HALF = 110;

/**
 * Where a detour crosses over itself: pairs of points on its path that coincide in the plan view but are far apart along
 * the road. The earlier of the two is the higher; if it is high enough above the later one it goes over on a viaduct.
 */
function findViaducts(spur) {
  const { X, Y, E, n } = spur;
  const found = [];
  for (let i = 0; i <= n; i += 2) {
    for (let j = 0; j < i; j += 2) {
      if ((i - j) * DS < 400) continue;
      if (Math.hypot(X[i] - X[j], Y[i] - Y[j]) > 9) continue;
      const drop = E[j * DS] - E[i * DS];
      if (drop < 25) continue;
      const last = found[found.length - 1];
      if (last && (i - last.lowerI) * DS < 300) { // the same crossing, seen again a sample later
        if (Math.hypot(X[i] - X[j], Y[i] - Y[j]) < last.gap) Object.assign(last, { upperI: j, lowerI: i, gap: Math.hypot(X[i] - X[j], Y[i] - Y[j]), drop });
        continue;
      }
      found.push({ upperI: j, lowerI: i, gap: Math.hypot(X[i] - X[j], Y[i] - Y[j]), drop });
    }
  }
  return found.map((f) => ({ upper: f.upperI * DS, lower: f.lowerI * DS, drop: f.drop }));
}

// -- Death Road: switchbacks up a mountain to the west, then a long descent to the start/finish line
export const DEATH_AVG_GRADE = 0.086; // 20 minutes at 6.5 W/kg for a 75 kg rider
const DEATH = (() => {
  const fork = 8000, rejoin = LOOP;
  const jp = mainPos(fork), th = mainHeading(fork), rp = mainPos(rejoin), tr = mainHeading(rejoin);
  const km = (x, y) => [x * 1000, y * 1000];
  // the climb: turn off to the right, head west, then up the mountain in six long legs joined by hairpins
  const t = turtlePath(jp.x, jp.y, th);
  t.line(80); t.arc(-100, 170); t.line(450); t.arc(-100, 120);
  let left = true;
  for (let i = 0; i < 6; i++) { t.line(840); if (i < 5) { t.arc(left ? 180 : -180, 65); left = !left; } }
  let climbLen = 0;
  for (let i = 1; i < t.pts.length; i++) climbLen += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
  // the descent: off the summit, then three spiral loops in a staircase down the mountainside. Each loop curls round through
  // 270 degrees and crosses over its own earlier road on a viaduct; they alternate right and left, so the staircase
  // runs straight down and the last one (a right turn) leaves heading east, towards the start line.
  const LOOP_R = 180;
  t.line(500);
  for (let i = 0; i < 3; i++) {
    const right = i % 2 === 0;
    t.arc(right ? -270 : 270, LOOP_R);
    if (i < 2) { t.line(520); t.arc(right ? -90 : 90, LOOP_R); t.line(320); }
  }
  const spiralEnd = t.pose();
  const endDir = unit(spiralEnd.h), fin = unit(tr), finRight = unit(tr - Math.PI / 2);
  const way = [
    [spiralEnd.x, spiralEnd.y], [spiralEnd.x + endDir[0] * 200, spiralEnd.y + endDir[1] * 200],
    [rp.x - fin[0] * 650 + finRight[0] * 230, rp.y - fin[1] * 650 + finRight[1] * 230], [rp.x - fin[0] * 80, rp.y - fin[1] * 80], [rp.x, rp.y],
  ];
  const descent = curveThrough(way, endDir, fin, 300, 300);
  const dense = [...t.pts.slice(0, -1), ...descent];
  const climb = Math.round(climbLen / DS) * DS;
  // The climb profile: the grade ramps up from flat over the first 150 to 450 m (where the road is still shared with the
  // loop), then holds near `avg`, swinging a little either side of it. Heights are the running total of that grade.
  const climbHeights = (avg) => {
    const h = new Float64Array(climb + 1);
    for (let q = 1; q <= climb; q++) {
      const u = q / climb;
      const ramp = smooth((q - 150) / 300);
      h[q] = h[q - 1] + avg * ramp * (1 + 0.18 * Math.sin(Math.PI * 2 * 9 * u + 0.5));
    }
    return h;
  };
  const build = (avg) => {
    const h = climbHeights(avg);
    const raw = (q, len, { forkE, hi }) => {
      if (q <= climb) return forkE + h[Math.min(climb, Math.max(0, Math.round(q)))];
      const topE = forkE + h[climb];
      // the descent is steady too, and comes down to the height of the loop 450 m short of the line, where the two roads meet
      const span = len - 450 - climb;
      const w = (q - climb) / span;
      if (w > 1) return hi - ((topE - hi) / span) * (q - (len - 450)); // carry on at the same steady fall while the loop's own profile takes over
      return topE - (topE - hi) * (w + (0.05 * (Math.cos(0.3) - Math.cos(Math.PI * 2 * 6 * w + 0.3))) / (Math.PI * 2 * 6));
    };
    return buildSpur({
      fork, rejoin, dense,
      // round off the crest at the summit, so the road tops out smoothly instead of kinking from +9% to -5%
      profile: (q, len, ctx) => {
        const t = smooth(1 - Math.abs(q - climb) / 160);
        if (!t) return raw(q, len, ctx);
        let sum = 0;
        for (let d = -120; d <= 120; d += 12) sum += raw(q + d, len, ctx);
        return raw(q, len, ctx) * (1 - t) + (sum / 21) * t;
      },
      roll: (u) => 0.5 * Math.sin(u * Math.PI * 2 * 40 + 1) + 0.2 * Math.sin(u * Math.PI * 2 * 110),
    });
  };
  // the ramp costs a little height, so lift the grade until the whole climb averages what we want
  let avg = DEATH_AVG_GRADE;
  let spur = build(avg);
  for (let pass = 0; pass < 4; pass++) {
    avg *= DEATH_AVG_GRADE / ((spur.E[climb] - spur.E[0]) / climb);
    spur = build(avg);
  }
  return { ...spur, fork, rejoin, climb, viaducts: findViaducts(spur), id: 'death', name: 'Death Road', color: '#ff7a59' };
})();

/** What the HUD says about each detour. */
const km1 = (m) => (m / 1000).toFixed(1);
const SPUR_TEXT = {
  valley: {
    stripLabel: 'around',
    question: 'Up the Col, or around?',
    ask: (sp) => `Around is ${km1(sp.len)} km of flat road, with no climb.`,
    armedTitle: 'Going around',
    armedSub: 'Bear right at the fork to skip the climb.',
    button: 'Go around',
    cancel: 'Ride up instead',
    onTitle: 'Valley Road',
    onSub: 'Then you rejoin the loop.',
    armText: { title: 'Going around', sub: 'Bear right at the fork' },
    disarmText: { title: 'Riding up the Col', sub: 'Stay on the loop' },
    passText: { title: 'Up the Col', sub: 'You stayed on the loop' },
    doneText: { title: 'Back on the loop', sub: 'Valley Road done' },
  },
  death: {
    stripLabel: 'Death Road',
    question: 'Finish, or Death Road?',
    ask: (sp) => `Death Road is a steep ${km1(sp.climb)} km climb, then a long descent.`,
    armedTitle: 'Taking Death Road',
    armedSub: 'Bear right at the fork. It is a long, steep climb.',
    button: 'Take Death Road',
    cancel: 'Finish the lap instead',
    onTitle: 'Death Road',
    onSub: 'Then you reach the finish line.',
    armText: { title: 'Taking Death Road', sub: 'Bear right at the fork' },
    disarmText: { title: 'Finishing the lap', sub: 'Stay on the loop' },
    passText: { title: 'On to the finish', sub: 'You passed Death Road' },
    doneText: { title: 'Death Road done!', sub: 'Back at the start / finish line' },
  },
};

/**
 * The detours, in coordinate order. `base` is the course coordinate of the fork end; `end` of the rejoin end. The ranges
 * are separated by a small gap so that no coordinate belongs to two of them.
 */
export const SPURS = (() => {
  let base = LOOP;
  return [VALLEY, DEATH].map((s, index) => {
    const out = { ...s, index, base, end: base + s.len, ...SPUR_TEXT[s.id] };
    base = out.end + 100;
    return out;
  });
})();
export const TOTAL = SPURS[SPURS.length - 1].end;

/**
 * Stretches of road carried over the road beneath them: { c0, c1 } in course coordinates (the whole span is raised on a
 * viaduct), the spur it is on, and how far above the lower road the deck is at the crossing.
 */
export const VIADUCTS = SPURS.flatMap((sp) => (sp.viaducts ?? []).map((v) => ({
  spur: sp.index, c0: sp.base + v.upper - VIADUCT_HALF, c1: sp.base + v.upper + VIADUCT_HALF, centre: sp.base + v.upper, lower: sp.base + v.lower, drop: v.drop,
})));
/** True for a course coordinate on a viaduct deck (the ground beneath is a ravine, not this road). */
export const onViaduct = (c, margin = 0) => c >= LOOP && VIADUCTS.some((v) => c >= v.c0 + margin && c <= v.c1 - margin);

/** Which detour a course coordinate is on (0, 1, ...), or -1 on the main loop. */
export function spurAt(c) {
  if (!(c >= LOOP && c <= TOTAL)) return -1;
  for (const s of SPURS) if (c <= s.end) return s.index;
  return SPURS.length - 1;
}
export const onSpur = (c) => c >= LOOP && c <= TOTAL;

const spurTab = (arr, s, n) => {
  const p = Math.min(n, Math.max(0, s / DS));
  const i = Math.min(n - 1, Math.floor(p));
  return arr[i] * (1 - (p - i)) + arr[i + 1] * (p - i);
};
const along = (c) => { const sp = SPURS[spurAt(c)]; return [sp, c - sp.base]; };

/** Signed curvature (1/m); positive = turning left. */
export const curvatureAt = (c) => { if (!onSpur(c)) return mainCurvature(c); const [sp, s] = along(c); return spurTab(sp.kap, s, sp.n); };
/** Heading in radians (anticlockwise from east), unwrapped so it keeps counting across laps and around the detours. */
export const headingAt = (c) => { if (!onSpur(c)) return mainHeading(c); const [sp, s] = along(c); return spurTab(sp.th, s, sp.n); };
/** Map position in metres: x = east, y = north. */
export const posAt = (c) => {
  if (!onSpur(c)) return mainPos(c);
  const [sp, s] = along(c);
  return { x: spurTab(sp.X, s, sp.n), y: spurTab(sp.Y, s, sp.n) };
};
export function elevation(c) {
  if (!onSpur(c)) return mainElevation(c);
  const [sp, s0] = along(c);
  const s = Math.min(sp.len, Math.max(0, s0));
  const i = Math.min(sp.len - 1, Math.floor(s));
  return sp.E[i] + (sp.E[i + 1] - sp.E[i]) * (s - i);
}
export const gradeAt = (c) => {
  if (!onSpur(c)) return mainGrade(c);
  const [sp, s] = along(c);
  const a = Math.max(0, s - 6), b = Math.min(sp.len, s + 6);
  return b > a ? (elevation(sp.base + b) - elevation(sp.base + a)) / (b - a) : 0;
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
  { id: 'flats', name: 'Valley Road', blurb: 'Flat and open, around the mountain. Find your rhythm', start: SPURS[0].base, end: SPURS[0].end, ground: [168, 176, 92] },
  { id: 'deathroad', name: 'Death Road', blurb: 'Switchbacks, sheer drops and thin air', start: SPURS[1].base, end: SPURS[1].end, ground: [104, 112, 90] },
];
/** How many zones make up the loop itself; the zones after them belong to the detours, in order. */
export const LOOP_BIOMES = 7;

export function biomeIndex(c) {
  if (onSpur(c)) return LOOP_BIOMES + spurAt(c);
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
  const sp = spur ? SPURS[spurAt(p)] : null;
  const nextI = sp ? biomeIndex(wrap(sp.rejoin)) : (i + 1) % LOOP_BIOMES;
  const prevI = sp ? biomeIndex(sp.fork) : (i - 1 + LOOP_BIOMES) % LOOP_BIOMES;
  if (toEnd < B) ground = mixc(ground, BIOMES[nextI].ground, 0.5 * (1 - toEnd / B));
  else if (fromStart < B) ground = mixc(ground, BIOMES[prevI].ground, 0.5 * (1 - fromStart / B));
  const alt = elevation(p);
  const snow = smooth((alt - 1320) / 35) * (spur ? smooth((alt - 1500) / 120) : p > 3300 && p < 5300 ? 1 : 0); // the high pass, and the top of Death Road
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
  // on Valley Road
  { id: 'windfarm', name: 'Valley Windmills', d: SPURS[0].base + 2900, lat: -24, kind: 'windmill', emoji: '💨' },
  { id: 'herd', name: 'Valley Herd', d: SPURS[0].base + 6600, lat: 16, kind: 'cows', emoji: '🐂' },
  // on Death Road
  { id: 'hut', name: 'Switchback Hut', d: SPURS[1].base + 1700, lat: 17, kind: 'cabin', emoji: '🛖' },
  { id: 'spiral', name: 'Spiral Viaducts', d: VIADUCTS[0].centre, lat: 0, kind: 'bridge', emoji: '🌀' },
  { id: 'deathtop', name: 'Death Road Summit', d: SPURS[1].base + SPURS[1].climb, lat: 0, kind: 'summit', emoji: '💀', label: 'DEATH ROAD SUMMIT' },
];

// ---- Lake (shared by the 3D world and the map) -------------------------------------------------------

/** An ellipse on the left of the road, centred `offset` m from the road at distance `d`. */
export const LAKE_SHAPE = { d: 8150, offset: 340, ra: 460, rb: 270 }; // sized and placed so the road never touches the water

// ---- Climbs ---------------------------------------------------------------------------------------------

export const CLIMBS = [
  { id: 'col', name: 'Col de SpinQuest', start: 1500, end: 4600 },
  { id: 'death', name: 'Death Road', start: SPURS[1].base, end: SPURS[1].base + SPURS[1].climb },
];

const clampN = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Where a rider stands on a climb at distance d: what's left, how steep it is now and what's coming.
 * Elevations and grades are real (not the exaggerated 3D ones).
 */
export function climbStats(climb, d) {
  const p = climb.start >= LOOP ? d : wrap(d); // a climb on a detour is in that detour's own coordinates
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
  const spur = onSpur(d);
  const p = spur ? d : wrap(d);
  for (const climb of CLIMBS) {
    if ((climb.start >= LOOP) !== spur) continue;
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
  const onDetour = climb.start >= LOOP;
  const climbSpur = onDetour ? spurAt(climb.start) : -1;
  let prev = null, t0 = null, lap = 1, lastMain = null;
  const cOf = (s) => s.c ?? wrap(s.d);
  samples.forEach((s, i) => {
    const c = cOf(s);
    if (!onSpur(c)) { // crossing the start line begins the next lap
      if (lastMain != null && c < lastMain - LOOP / 2) lap++;
      lastMain = c;
    } else lastMain = SPURS[spurAt(c)].rejoin; // out on a detour: the next point on the loop is where it rejoins
    if (spurAt(c) === climbSpur) { // on the stretch of road this climb is on
      if (prev == null && onDetour) { // just turned onto the detour: its own road starts at its base
        prev = SPURS[climbSpur].base;
        if (climb.start <= prev) t0 = i; // a climb that starts at the fork is timed from the moment you turn off
      }
      if (prev != null && prev < climb.start && climb.start <= c && c - prev < 200) t0 = i + (climb.start - prev) / (c - prev);
      if (t0 != null && prev != null && prev < climb.end && climb.end <= c && c - prev < 200) {
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
      prev = c;
    } else {
      t0 = null; // left the road this climb is on
      prev = onDetour ? null : (onSpur(c) ? SPURS[spurAt(c)].rejoin : c);
    }
  });
  return out;
}

// ---- Timed segments ---------------------------------------------------------------------------

export const SEGMENTS = [
  { id: 'kom', name: 'Col Climb', kind: 'climb', start: 2300, end: 4600, color: '#ff4d4d' },
  { id: 'descent', name: 'Switchback Run', kind: 'sprint', start: 4950, end: 5750, color: '#c25cff' },
  { id: 'lake', name: 'Lakeside Sprint', kind: 'sprint', start: 7900, end: 8300, color: '#3ecf6e' },
  { id: 'village', name: 'Village Crit', kind: 'sprint', start: 8500, end: 8950, color: '#ff9f2e' },
  { id: 'death', name: 'Death Road Climb', kind: 'climb', start: SPURS[1].base + 300, end: SPURS[1].base + SPURS[1].climb, color: '#ff7a59' },
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

/** The detours' points (in coordinate order), and the bounds of the whole course (loop and detours) for the map. */
export const SPUR_MAP = (() => {
  const pts = [];
  for (const sp of SPURS) {
    for (let q = 0; q <= sp.len; q += 25) {
      const p = posAt(sp.base + q);
      pts.push({ d: sp.base + q, x: p.x, y: p.y, g: gradeAt(sp.base + q) });
    }
  }
  const xs = pts.map((p) => p.x).concat(MAP.minX, MAP.maxX), ys = pts.map((p) => p.y).concat(MAP.minY, MAP.maxY);
  return { pts, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
})();
