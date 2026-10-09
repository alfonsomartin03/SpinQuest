// Third-person renderer: a pseudo-3D chase camera behind the rider. The road bends, rises and
// falls with the course. Each zone of the loop has its own scenery, with landmarks to ride past,
// a tunnel, a covered bridge, a lake and crowds. Riders are seen from behind, and stat-driven
// effects sit on top.

import { POWER_ZONES, HR_ZONES, clamp } from './physics.js';
import {
  elevation, SEGMENTS, LOOP, LANDMARKS, TUNNEL, BRIDGE, envAt, curvatureAt, headingAt,
} from './course.js';
import { orbAt, hash, ORB_SPACING } from './game.js';

const VEX = 2.4; // elevation exaggeration so hills read on screen
const SEG = 2.2; // road slice length (m)
const MAXZ = 270; // draw distance (m)
const CAM_BACK = 5.8; // camera sits this far behind the user (m)
const CAM_H = 1.8; // camera height above the road (m)
const ROAD_HALF = 4.2; // half road width (m)
const CURVE_GAIN = 1.6; // exaggerate road bends a little
const TAU = Math.PI * 2;

const SKY = [
  [0.0, '#2b3a67', '#f7a278'],
  [0.12, '#4a90d9', '#bfe3ff'],
  [0.5, '#3a86e0', '#a8dcff'],
  [0.7, '#5b5fb0', '#ffb26b'],
  [0.8, '#1a1d4a', '#c0517a'],
  [0.9, '#0a0f2a', '#1b2352'],
  [1.0, '#2b3a67', '#f7a278'],
];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const hexA = (h, a) => rgb(hex(h), a);
const wrapLoop = (d) => ((d % LOOP) + LOOP) % LOOP;

function skyAt(tod) {
  for (let i = 1; i < SKY.length; i++) {
    if (tod <= SKY[i][0]) {
      const k = (tod - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
      return [mix(hex(SKY[i - 1][1]), hex(SKY[i][1]), k), mix(hex(SKY[i - 1][2]), hex(SKY[i][2]), k)];
    }
  }
  return [hex(SKY[0][1]), hex(SKY[0][2])];
}

/** What grows beside the road in each zone: density, lateral range and weighted prop kinds. */
const SCENERY = [
  { d: 0.6, min: 5.5, spread: 14, kinds: [['flowers', 5], ['tree', 2], ['bush', 2], ['fence', 1.2], ['hay', 1]] },
  { d: 0.9, min: 5.5, spread: 14, kinds: [['pine', 7], ['birch', 1], ['bush', 1], ['rock', 1]] },
  { d: 0.5, min: 5.5, spread: 16, kinds: [['pine', 4], ['rock', 5], ['bush', 0.5]] },
  { d: 0.65, min: 5.5, spread: 14, kinds: [['orchard', 3], ['tree', 2], ['bush', 1.5], ['flowers', 2], ['fence', 1.5]] },
  { d: 0.55, min: 6, spread: 13, kinds: [['birch', 3], ['reeds', 3], ['tree', 1.5], ['bush', 1.5], ['rock', 1], ['house', 0.4]] },
  { d: 0.9, min: 7, spread: 9, kinds: [['house', 6], ['lamp', 2.5], ['tree', 1.2], ['bush', 1.5]] },
  { d: 0.6, min: 5.5, spread: 14, kinds: [['wheat', 5], ['hay', 3], ['tree', 1], ['fence', 1.5]] },
];

const HOUSE_COLORS = [[235, 214, 180], [222, 170, 150], [190, 205, 225], [240, 232, 200], [205, 190, 170]];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.pending = [];
    this.snow = Array.from({ length: 110 }, (_, i) => ({ x: hash(i), y: hash(i + 50), s: 0.4 + hash(i + 7) }));
    this.camE = null;
    this.userLat = 0;
    this.w = 0;
    this.h = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth || innerWidth;
    this.h = this.canvas.clientHeight || innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Apply game events (orb pickups) to the effects layer. */
  handleEvents(events) {
    this.pending = this.pending.concat(events.filter((e) => e.type === 'orb'));
  }

  draw(game, dt) {
    const { w, h } = this;
    const user = game.user;
    const camX = user.x - CAM_BACK;
    const e0 = elevation(camX);
    this.camE = this.camE == null ? e0 : this.camE + (e0 - this.camE) * (1 - Math.exp(-dt * 5));
    this.f = h * 0.95;
    this.u = Math.min(w / 1400, h / 800);
    this.clock = game.clock;
    const hz = h * 0.4;

    // Time of day follows the course: bright morning on the climb, golden hour at the lake.
    const prog = wrapLoop(user.x) / LOOP;
    this.tod = 0.12 + 0.6 * (0.5 - 0.5 * Math.cos(TAU * (prog - 0.78)));
    const [skyTop, skyBot] = skyAt(this.tod);
    this.fogC = skyBot;
    this.dim = 1;
    this.gold = clamp(1 - Math.abs(this.tod - 0.68) / 0.14, 0, 1);
    this.env = envAt(user.x);

    // the rider drifts toward the next orb so the line looks natural
    let want = 0;
    const i0 = Math.floor(user.x / ORB_SPACING);
    for (let i = i0; i < i0 + 5; i++) {
      const o = orbAt(i);
      if (o && !game.collected.has(i) && o.x > user.x) { want = o.lat; break; }
    }
    this.userLat += (want - this.userLat) * (1 - Math.exp(-dt * 2.5));
    user.lat = this.userLat;
    const camLat = this.userLat * 0.6;
    const bgShift = -headingAt(camX) * w * 1.1;

    this.#sky(skyTop, skyBot, bgShift, hz);
    this.#hills(bgShift, hz);
    this.ctx.fillStyle = rgb(mix(this.env.ground, this.fogC, 0.1));
    this.ctx.fillRect(0, hz, w, h - hz);

    const R = this.#project(camX, hz, camLat);
    this.#road(R);
    this.#sprites(R, game, camX, camLat);
    this.#effects(game, dt, R, hz, camLat);
    this.#atmosphere(game);
  }

  // ---- fog -------------------------------------------------------------------------------

  #fogAmt(z) { return clamp((z - 35) / 235, 0, 1) ** 1.3 * 0.82; }
  /** CSS colour for an [r,g,b] base colour at depth z, fogged toward the horizon colour. */
  #fc(c, z, shade = 1) { return rgb(mix([c[0] * shade, c[1] * shade, c[2] * shade], this.fogC, this.#fogAmt(z))); }

  // ---- backdrop ----------------------------------------------------------------------

  #sky(top, bot, shift, hz) {
    const { ctx, w } = this;
    const g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, rgb(top));
    g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hz + 2);

    const k = clamp((this.tod - 0.1) / 0.62, 0, 1);
    this.#glow(w * (0.12 + 0.76 * k) - shift * 0.1, hz * 0.85 - Math.sin(Math.PI * k) * hz * 0.6, hz * 0.07, this.gold > 0.2 ? '255,190,120' : '255,236,170');

    // clouds
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 7; i++) {
      const span = w * 1.6;
      const x = ((((hash(i * 7) * span - shift * 0.25 - this.clock * 5) % span) + span) % span) - w * 0.3;
      const y = hz * (0.08 + hash(i * 3) * 0.55);
      const s = (45 + hash(i) * 55) * (w / 1400);
      for (const [dx, dy, r] of [[0, 0, 1], [0.8, 0.15, 0.7], [-0.8, 0.2, 0.65], [0.3, -0.3, 0.7]]) {
        ctx.beginPath(); ctx.ellipse(x + dx * s, y + dy * s, s * r * 1.1, s * r * 0.55, 0, 0, 7); ctx.fill();
      }
    }
    this.#balloons(shift, hz);
    this.#birds(hz);
  }

  #glow(x, y, r, c) {
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, `rgba(${c},1)`);
    g.addColorStop(0.25, `rgba(${c},0.8)`);
    g.addColorStop(1, `rgba(${c},0)`);
    this.ctx.fillStyle = g;
    this.ctx.beginPath(); this.ctx.arc(x, y, r * 4, 0, 7); this.ctx.fill();
  }

  #balloons(shift, hz) {
    const { ctx, w } = this;
    const u = this.u;
    const cols = [['#ff5a5f', '#ffd166'], ['#3fa9f5', '#ffffff'], ['#6ee7b7', '#f472b6']];
    cols.forEach(([a, b], i) => {
      const span = w * 2.4;
      const x = ((((hash(i * 11) * span - shift * 0.18 + this.clock * (2 + i)) % span) + span) % span) - w * 0.7;
      const y = hz * (0.18 + i * 0.12) + Math.sin(this.clock * 0.4 + i) * 6 * u;
      const r = (26 - i * 3) * u;
      ctx.fillStyle = a;
      ctx.beginPath(); ctx.ellipse(x, y, r * 0.85, r, 0, 0, 7); ctx.fill();
      ctx.fillStyle = b;
      ctx.beginPath(); ctx.ellipse(x, y, r * 0.3, r, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(40,30,20,.6)'; ctx.lineWidth = Math.max(1, u);
      ctx.beginPath(); ctx.moveTo(x - r * 0.4, y + r * 0.9); ctx.lineTo(x - r * 0.18, y + r * 1.5); ctx.moveTo(x + r * 0.4, y + r * 0.9); ctx.lineTo(x + r * 0.18, y + r * 1.5); ctx.stroke();
      ctx.fillStyle = '#6b4a2b'; ctx.fillRect(x - r * 0.22, y + r * 1.5, r * 0.44, r * 0.3);
    });
  }

  #birds(hz) {
    const { ctx, w } = this;
    const u = this.u;
    ctx.strokeStyle = 'rgba(30,35,50,.65)'; ctx.lineWidth = 1.6 * u; ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const x = ((this.clock * 28 + i * 38) % (w + 240)) - 120;
      const y = hz * 0.32 + Math.sin(this.clock * 0.7 + i) * 14 * u + (i % 3) * 14 * u;
      const flap = Math.sin(this.clock * 9 + i * 1.7) * 5 * u;
      ctx.beginPath();
      ctx.moveTo(x - 9 * u, y + flap); ctx.quadraticCurveTo(x - 4 * u, y - 4 * u, x, y);
      ctx.quadraticCurveTo(x + 4 * u, y - 4 * u, x + 9 * u, y + flap);
      ctx.stroke();
    }
  }

  #hills(shift, hz) {
    const { ctx, w } = this;
    const u = this.u;
    const sn = this.env.snow;
    const layers = [
      { par: 0.35, lift: 0.1, amp: 120, col: [104, 126, 172], caps: true },
      { par: 0.6, lift: 0.04, amp: 76, col: [74, 122, 128], caps: sn > 0.1 || this.env.biome === 2 },
      { par: 1.0, lift: 0.0, amp: 42, col: mix(this.env.ground, [30, 80, 50], 0.25), caps: false },
    ];
    layers.forEach((L, li) => {
      const fogged = mix(L.col, this.fogC, 0.25 + 0.18 * (2 - li));
      if (L.caps) {
        const g = ctx.createLinearGradient(0, hz - hz * L.lift - L.amp * u * 1.6, 0, hz);
        g.addColorStop(0, 'rgb(246,249,255)');
        g.addColorStop(0.28, 'rgb(236,242,252)');
        g.addColorStop(0.34, rgb(fogged));
        g.addColorStop(1, rgb(fogged));
        ctx.fillStyle = g;
      } else ctx.fillStyle = rgb(fogged);
      ctx.beginPath();
      ctx.moveTo(0, hz + 4);
      for (let x = 0; x <= w + 10; x += 10) {
        const wx = (x + shift * L.par) / u;
        const y = hz - hz * L.lift - L.amp * u * (0.55 * Math.sin(wx / 190 + li * 2) + 0.3 * Math.sin(wx / 83 + li) + 0.15 * Math.sin(wx / 41)) - 20 * u;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, hz + 4);
      ctx.fill();
    });
  }

  // ---- road ---------------------------------------------------------------------------

  /** Project road slices ahead of the camera into screen space. */
  #project(camX, hz, camLat) {
    const { w, f } = this;
    const first = Math.floor(camX / SEG) + 1;
    const N = Math.ceil(MAXZ / SEG);
    const R = { X: [], z: [], y: [], x: [], sc: [], vis: [], env: [], N };
    let hd = 0;
    let lat = 0;
    let zPrev = 0;
    for (let j = 0; j <= N; j++) {
      const X = j === 0 ? camX + 0.9 : (first + j - 1) * SEG;
      const z = j === 0 ? 0.9 : Math.max(X - camX, zPrev + 0.05);
      hd += -curvatureAt(X) * CURVE_GAIN * (z - zPrev); // left turn (+) moves the road left on screen
      lat += hd * (z - zPrev);
      zPrev = z;
      const sc = f / z;
      R.X.push(X);
      R.z.push(z);
      R.sc.push(sc);
      R.y.push(hz + (CAM_H - (elevation(X) - this.camE) * VEX) * sc);
      R.x.push(w / 2 + (lat - camLat) * sc);
      R.env.push(envAt(X));
    }
    let clip = Infinity; // slices hidden behind a nearer crest are skipped
    for (let j = 0; j < N; j++) {
      R.vis.push(R.y[j + 1] < clip);
      clip = Math.min(clip, R.y[j + 1]);
    }
    return R;
  }

  #road(R) {
    const { ctx, w } = this;
    // polygon between lateral offsets l0..l1 (metres from the road centre) on slice j
    const quad = (j, l0, l1) => {
      ctx.beginPath();
      ctx.moveTo(R.x[j] + l0 * R.sc[j], R.y[j]); ctx.lineTo(R.x[j] + l1 * R.sc[j], R.y[j]);
      ctx.lineTo(R.x[j + 1] + l1 * R.sc[j + 1], R.y[j + 1]); ctx.lineTo(R.x[j + 1] + l0 * R.sc[j + 1], R.y[j + 1]);
      ctx.fill();
    };
    for (let j = R.N - 1; j >= 0; j--) {
      if (!R.vis[j]) continue;
      const y0 = R.y[j], y1 = R.y[j + 1];
      if (y0 < y1) continue; // faces away
      const z = R.z[j + 1];
      const e = R.env[j];
      const X = R.X[j + 1];
      const stripe = Math.floor(X / SEG);
      const odd = stripe % 2;
      const onBridge = Math.abs(X - BRIDGE.x) < BRIDGE.half;
      const ground = e.ground.map((v) => v * (odd ? 1 : 0.93));
      ctx.fillStyle = this.#fc(ground, z);
      ctx.fillRect(0, y1, w, y0 - y1 + 1);
      // verge
      ctx.fillStyle = this.#fc(ground.map((v) => v * 1.07), z);
      quad(j, -ROAD_HALF - 2.6, -ROAD_HALF);
      quad(j, ROAD_HALF, ROAD_HALF + 2.6);

      // lake on the left, with a sandy shore and shimmering ripples
      if (e.water > 0.03) {
        const shore = -(ROAD_HALF + 7 + (1 - e.water) * 110);
        ctx.fillStyle = this.#fc([214, 196, 150], z);
        quad(j, shore, shore + 2.4);
        const shimmer = Math.sin(X * 0.35 + this.clock * 1.6) * 0.5 + 0.5;
        const wc = mix([48, 128, 196], [120, 200, 235], (odd ? 0.15 : 0.0) + shimmer * 0.12 + this.gold * 0.15);
        ctx.fillStyle = this.#fc(wc, z);
        ctx.beginPath();
        ctx.moveTo(0, y1); ctx.lineTo(R.x[j + 1] + shore * R.sc[j + 1], y1);
        ctx.lineTo(R.x[j] + shore * R.sc[j], y0); ctx.lineTo(0, y0);
        ctx.fill();
      }
      // stream under the covered bridge
      if (Math.abs(X - BRIDGE.x) < BRIDGE.half + 5) {
        ctx.fillStyle = this.#fc([60, 140, 205], z);
        quad(j, -90, -ROAD_HALF);
        quad(j, ROAD_HALF, 90);
        ctx.fillStyle = this.#fc([100, 70, 45], z);
        quad(j, -ROAD_HALF - 0.8, ROAD_HALF + 0.8);
      }

      ctx.fillStyle = this.#fc(Math.floor(stripe / 2) % 2 ? [220, 60, 60] : [235, 235, 235], z);
      if (!onBridge) { quad(j, -ROAD_HALF - 0.5, -ROAD_HALF); quad(j, ROAD_HALF, ROAD_HALF + 0.5); }
      const asphalt = onBridge ? [138, 98, 62] : (odd ? [74, 79, 92] : [68, 73, 86]);
      ctx.fillStyle = this.#fc(asphalt, z);
      quad(j, -ROAD_HALF, ROAD_HALF);
      ctx.fillStyle = this.#fc([255, 255, 255], z, 0.9);
      if (!onBridge) { quad(j, -ROAD_HALF + 0.25, -ROAD_HALF + 0.42); quad(j, ROAD_HALF - 0.42, ROAD_HALF - 0.25); }
      if (Math.floor(R.X[j] / (SEG * 2)) % 2 === 0) quad(j, -0.06, 0.06);
      const ph = wrapLoop(R.X[j]);
      const seg = SEGMENTS.find((s) => ph >= s.start && ph < s.end);
      if (seg) {
        ctx.fillStyle = hexA(seg.color, 0.55);
        quad(j, -ROAD_HALF + 0.45, -ROAD_HALF + 0.85);
        quad(j, ROAD_HALF - 0.85, ROAD_HALF - 0.45);
      }
    }
  }

  /** Screen position of the road `z` metres ahead of the camera, shifted by lateral metres `lat`. */
  #at(R, z, lat = 0) {
    if (z < 0.9 || z >= R.z[R.N]) return null;
    let j = 0;
    while (j < R.N - 1 && R.z[j + 1] <= z) j++;
    if (!R.vis[j]) return null;
    const k = clamp((z - R.z[j]) / (R.z[j + 1] - R.z[j]), 0, 1);
    const lerp = (a) => a[j] + (a[j + 1] - a[j]) * k;
    const sc = this.f / z;
    return { x: lerp(R.x) + lat * sc, y: lerp(R.y), sc, z };
  }

  // ---- building the sprite list ----------------------------------------------------------

  #sprites(R, game, camX, camLat) {
    const list = [];
    const zOf = (X) => X - camX;
    const near = (X) => X > camX - 5 && X < camX + MAXZ;
    const laps = [Math.floor(camX / LOOP) - 1, Math.floor(camX / LOOP), Math.floor(camX / LOOP) + 1];
    const add = (X, lat, kind, extra = {}) => { if (near(X)) list.push({ z: zOf(X), lat, kind, X, ...extra }); };
    const inTunnel = (X) => { const p = wrapLoop(X); return p > TUNNEL.start - 6 && p < TUNNEL.end + 6; };

    // roadside scenery by zone
    const cell = 12;
    const c0 = Math.floor(camX / cell);
    for (let c = c0; c < c0 + MAXZ / cell; c++) {
      for (const side of [-1, 1]) {
        const X = c * cell + hash(c * 2.3 + side) * 9;
        if (inTunnel(X)) continue;
        const e = envAt(X);
        const cfg = SCENERY[e.biome];
        if (hash(c * 1.7 + side * 0.37) > cfg.d) continue;
        const total = cfg.kinds.reduce((a, [, wgt]) => a + wgt, 0);
        let pick = hash(c * 5.1 + side) * total;
        let kind = cfg.kinds[0][0];
        for (const [kd, wgt] of cfg.kinds) { if ((pick -= wgt) <= 0) { kind = kd; break; } }
        let lat = side * (cfg.min + hash(c * 3.3 + side) * cfg.spread);
        if (e.water > 0.4 && side < 0) { if (kind !== 'reeds') continue; lat = -(6.5 + hash(c) * 3); }
        if (kind === 'reeds' && e.water < 0.4) continue;
        if (Math.abs(wrapLoop(X) - BRIDGE.x) < 16) continue;
        if (kind === 'pine' && e.snow > 0.3) kind = 'snowpine';
        if (kind === 'rock' && e.snow > 0.3) kind = 'snowrock';
        add(X, lat, 'prop', { k: kind, s: 0.8 + hash(c * 9.3 + side) * 0.7, v: hash(c * 4.4 + side), e });
      }
    }
    // road markers: reflector posts and km signs
    for (let X = Math.floor(camX / 24) * 24; X < camX + MAXZ; X += 24) {
      if (inTunnel(X) || Math.abs(wrapLoop(X) - BRIDGE.x) < 12) continue;
      add(X, -ROAD_HALF - 1.1, 'post');
      add(X, ROAD_HALF + 1.1, 'post');
    }
    for (let X = Math.floor(camX / 1000) * 1000; X < camX + MAXZ; X += 1000) {
      add(X, ROAD_HALF + 1.8, 'kmsign', { km: Math.round(wrapLoop(X) / 1000) % 10 || 10 });
    }

    // landmarks, structures and crowds
    for (const k of laps) {
      const base = k * LOOP;
      for (const lm of LANDMARKS) {
        const X = base + lm.d;
        if (!near(X)) continue;
        list.push({ z: zOf(X), lat: lm.lat, kind: 'lm', lm, X });
        if (lm.kind === 'summit') for (let dx = -42; dx <= 42; dx += 6) for (const s of [-1, 1]) add(X + dx + s, s * (5.6 + hash(dx + s) * 2.4), 'crowd', { v: hash(dx * s + 3), flag: hash(dx + 9) > 0.5 });
        if (lm.kind === 'arch') for (let dx = -26; dx <= 26; dx += 5) for (const s of [-1, 1]) add(X + dx, s * (5.6 + hash(dx * s) * 2.4), 'crowd', { v: hash(dx * s + 7), flag: hash(dx + 5) > 0.4 });
        if (lm.kind === 'market') for (let dx = -30; dx <= 30; dx += 10) { add(X + dx, -7.5, 'prop', { k: 'stall', s: 1, v: hash(dx + 1), e: null }); add(X + dx + 4, 7.5, 'prop', { k: 'stall', s: 1, v: hash(dx + 6), e: null }); }
        if (lm.kind === 'cows') for (let i = 0; i < 4; i++) add(X + i * 7, (i % 2 ? 1 : -1) * (9 + i * 2), 'prop', { k: 'cow', s: 1, v: hash(i + 2), e: null });
        if (lm.kind === 'lighthouse') for (let i = 0; i < 4; i++) add(X - 160 + i * 120, -(28 + i * 16), 'prop', { k: 'boat', s: 1, v: hash(i + 4), e: null });
      }
      // village spectators, tunnel frames, bridge frames
      for (let X = base + 8500; X < base + 8950; X += 14) for (const s of [-1, 1]) if (hash(X * s) > 0.4) add(X + hash(X) * 5, s * 5.9, 'crowd', { v: hash(X + s), flag: hash(X + 3) > 0.6 });
      for (let X = base + TUNNEL.start; X <= base + TUNNEL.end; X += 8) {
        if (!near(X)) continue;
        const first = X === base + TUNNEL.start;
        if (first) list.push({ z: zOf(X) + 0.4, lat: 0, kind: 'tunnelcore', X });
        list.push({ z: zOf(X), lat: 0, kind: 'rib', first, X });
      }
      if (near(base + TUNNEL.end + 2)) list.push({ z: zOf(base + TUNNEL.end + 2), lat: 0, kind: 'tunnelexit', X: base + TUNNEL.end });
      for (let X = base + BRIDGE.x - BRIDGE.half; X <= base + BRIDGE.x + BRIDGE.half; X += 4.5) add(X, 0, 'bridgeframe', { end: Math.abs(X - base - BRIDGE.x) > BRIDGE.half - 1 });
      for (const s of SEGMENTS) {
        for (const [off, isEnd] of [[s.start, false], [s.end, true]]) {
          const X = base + off;
          if (near(X)) list.push({ z: zOf(X), lat: 0, kind: 'gantry', seg: s, end: isEnd, X });
        }
      }
    }
    // orbs and riders
    const o0 = Math.floor(camX / ORB_SPACING);
    for (let i = o0; i < o0 + MAXZ / ORB_SPACING; i++) {
      const o = orbAt(i);
      if (o && !game.collected.has(i)) list.push({ z: zOf(o.x), lat: o.lat, kind: 'orb', o });
    }
    for (const r of [...game.bots, ...(game.coach ? [game.coach] : []), game.user]) {
      const lat = r.isUser ? r.lat : r.lat + Math.sin(game.clock * 0.35 + (r.i ?? 7)) * 0.25;
      list.push({ z: zOf(r.x), lat, kind: 'rider', r });
    }
    list.sort((a, b) => b.z - a.z);

    const ctx = this.ctx;
    for (const it of list) {
      const P = this.#at(R, it.z, it.lat - camLat);
      if (!P) continue;
      switch (it.kind) {
        case 'orb': this.#orb(it.o, P.x, P.y, P.sc, game.clock); break;
        case 'rider': this.#rider(it.r, P.x, P.y, P.sc, game); break;
        case 'gantry': this.#gantry(P, it.end ? 'FINISH' : it.seg.name.toUpperCase(), it.seg.color, it.end, false); break;
        default:
          if (P.sc * 3 < 2.5 && it.kind !== 'rib') break; // too small to see
          ctx.save();
          ctx.translate(P.x, P.y);
          ctx.scale(P.sc, -P.sc); // draw in metres, y up
          this.#drawWorld(it, P);
          ctx.restore();
          if (it.kind === 'lm') this.#lmLabel(it, P);
      }
    }
  }

  // ---- world objects (drawn in metre space: y up) -----------------------------------------

  #rect(x, y, w, h, col) { this.ctx.fillStyle = col; this.ctx.fillRect(x, y, w, h); }
  #poly(pts, col) {
    const { ctx } = this;
    ctx.fillStyle = col;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.fill();
  }
  #circ(x, y, r, col) { const { ctx } = this; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
  #ell(x, y, rx, ry, col) { const { ctx } = this; ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, 7); ctx.fill(); }

  #drawWorld(it, P) {
    const z = P.z;
    const C = (r, g, b, shade = 1) => this.#fc([r, g, b], z, shade);
    switch (it.kind) {
      case 'prop': return this.#prop(it, C);
      case 'post': {
        this.#rect(-0.05, 0, 0.1, 0.95, C(235, 235, 235));
        this.#rect(-0.05, 0.55, 0.1, 0.2, C(210, 50, 50));
        return undefined;
      }
      case 'kmsign': {
        this.#rect(-0.06, 0, 0.12, 1.9, C(200, 200, 205));
        this.#rect(-0.6, 1.3, 1.2, 0.8, C(250, 250, 250));
        this.#rect(-0.6, 1.3, 1.2, 0.18, C(220, 60, 60));
        return undefined;
      }
      case 'crowd': return this.#person(it);
      case 'lm': return this.#landmark(it, C);
      case 'rib': return this.#rib(it, P);
      case 'tunnelcore': return this.#tunnelCore();
      case 'tunnelexit': return this.#tunnelExit();
      case 'bridgeframe': return this.#bridgeFrame(it, C);
      default: return undefined;
    }
  }

  #prop(it, C) {
    const { ctx } = this;
    const s = it.s;
    const v = it.v;
    const gold = this.gold;
    switch (it.k) {
      case 'tree':
      case 'orchard': {
        ctx.save(); ctx.scale(s, s);
        this.#rect(-0.25, 0, 0.5, 3, C(92, 62, 40));
        this.#circ(0, 4.9, 2.5, C(40, 112, 58));
        this.#circ(-1.5, 3.7, 1.8, C(46, 124, 64));
        this.#circ(1.5, 3.7, 1.8, C(36, 104, 54));
        this.#circ(-0.7, 5.6, 1.7, C(70, 150, 80));
        if (it.k === 'orchard') for (let i = 0; i < 7; i++) this.#circ(Math.sin(i * 2.3 + v * 9) * 2, 4.2 + Math.cos(i * 1.7) * 1.3, 0.22, C(215, 50, 50));
        ctx.restore();
        break;
      }
      case 'birch': {
        ctx.save(); ctx.scale(s, s);
        this.#rect(-0.17, 0, 0.34, 4.2, C(232, 230, 220));
        for (let i = 0; i < 4; i++) this.#rect(-0.17, 0.7 + i * 0.9, 0.34, 0.12, C(40, 40, 40));
        this.#ell(0, 5.5, 1.8, 2.6, C(120, 175, 80));
        this.#ell(-0.6, 6, 1.1, 1.8, C(150, 200, 100));
        ctx.restore();
        break;
      }
      case 'pine':
      case 'snowpine': {
        const snowy = it.k === 'snowpine';
        ctx.save(); ctx.scale(s, s);
        this.#rect(-0.22, 0, 0.44, 1.8, C(74, 52, 36));
        for (let i = 0; i < 4; i++) {
          const y = 1.2 + i * 2.1, wd = 2.7 - i * 0.55;
          this.#poly([[-wd, y], [0, y + 3.4], [wd, y]], C(28, 92, 62));
          this.#poly([[-wd, y], [0, y + 3.4], [-wd * 0.1, y]], C(40, 118, 78));
          if (snowy) this.#poly([[-wd * 0.7, y + 0.9], [0, y + 3.4], [wd * 0.7, y + 0.9], [wd * 0.3, y + 0.7], [0, y + 1.3], [-wd * 0.3, y + 0.7]], C(244, 248, 255));
        }
        ctx.restore();
        break;
      }
      case 'bush': {
        this.#ell(0, 0.6 * s, 1.5 * s, 0.9 * s, C(46, 128, 66));
        this.#ell(-0.4 * s, 0.9 * s, 0.9 * s, 0.6 * s, C(70, 154, 84));
        break;
      }
      case 'rock':
      case 'snowrock': {
        const sn = it.k === 'snowrock';
        this.#poly([[-1.6 * s, 0], [-1.1 * s, 1.4 * s], [0.3 * s, 2.1 * s], [1.5 * s, 1 * s], [1.8 * s, 0]], C(112, 114, 122));
        this.#poly([[-1.1 * s, 1.4 * s], [0.3 * s, 2.1 * s], [0.4 * s, 0.6 * s]], C(150, 152, 160));
        if (sn) this.#poly([[-1.1 * s, 1.4 * s], [0.3 * s, 2.1 * s], [1.1 * s, 1.4 * s], [0, 1.2 * s]], C(244, 248, 255));
        break;
      }
      case 'flowers': {
        this.#ell(0, 0.18, 1.1, 0.25, C(52, 140, 62));
        const cols = [[255, 90, 120], [255, 214, 80], [250, 250, 250], [170, 120, 240]];
        for (let i = 0; i < 9; i++) {
          const fx = (hash(i + v * 7) - 0.5) * 2.2, fh = 0.35 + hash(i + 3 + v) * 0.5;
          this.#rect(fx - 0.02, 0.1, 0.04, fh, C(60, 150, 70));
          const c = cols[Math.floor(hash(i + v * 3) * 4)];
          this.#circ(fx, fh + 0.12, 0.16, C(c[0], c[1], c[2]));
        }
        break;
      }
      case 'fence': {
        for (let i = 0; i < 3; i++) this.#rect(i * 1.8 - 0.06, 0, 0.12, 1.1, C(150, 112, 74));
        this.#rect(0, 0.75, 3.6, 0.1, C(170, 130, 88));
        this.#rect(0, 0.4, 3.6, 0.1, C(170, 130, 88));
        break;
      }
      case 'hay': {
        this.#circ(0, 0.95, 0.95 * s, C(222, 190, 90));
        ctx.strokeStyle = C(170, 140, 60); ctx.lineWidth = 0.06;
        ctx.beginPath(); ctx.arc(0, 0.95, 0.55 * s, 0, 5); ctx.stroke();
        break;
      }
      case 'wheat': {
        ctx.lineWidth = 0.07;
        for (let i = 0; i < 26; i++) {
          const fx = (hash(i + v * 5) - 0.5) * 3.2, hh = 1.0 + hash(i + 2) * 0.5, sw = Math.sin(this.clock * 1.6 + fx * 2) * 0.12;
          ctx.strokeStyle = C(214, 178, 70, 0.9 + hash(i) * 0.2);
          ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx + sw, hh); ctx.stroke();
          this.#ell(fx + sw, hh + 0.12, 0.07, 0.2, C(232, 196, 84));
        }
        break;
      }
      case 'reeds': {
        ctx.lineWidth = 0.08;
        for (let i = 0; i < 12; i++) {
          const fx = (hash(i + v * 6) - 0.5) * 2, hh = 1.2 + hash(i + 1) * 0.8, sw = Math.sin(this.clock * 1.3 + i) * 0.1;
          ctx.strokeStyle = C(88, 140, 70);
          ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx + sw, hh); ctx.stroke();
          if (i % 3 === 0) this.#rect(fx + sw - 0.07, hh - 0.35, 0.14, 0.4, C(110, 70, 40));
        }
        break;
      }
      case 'house': {
        const col = HOUSE_COLORS[Math.floor(v * HOUSE_COLORS.length)];
        const wd = 2.4 + v * 1.2;
        this.#rect(-wd, 0, wd * 2, 3.4, C(col[0], col[1], col[2]));
        this.#poly([[-wd - 0.5, 3.4], [0, 5.6], [wd + 0.5, 3.4]], C(v > 0.5 ? 168 : 120, v > 0.5 ? 70 : 76, 60));
        this.#rect(wd * 0.45, 4, 0.6, 1.4, C(120, 100, 90));
        this.#rect(-0.4, 0, 0.8, 1.7, C(110, 74, 46));
        const lit = gold > 0.3 ? C(255, 220, 130) : C(130, 185, 225);
        this.#rect(-wd + 0.5, 1.7, 0.9, 0.9, lit);
        this.#rect(wd - 1.4, 1.7, 0.9, 0.9, lit);
        break;
      }
      case 'lamp': {
        this.#rect(-0.05, 0, 0.1, 3.8, C(50, 54, 62));
        this.#rect(-0.25, 3.7, 0.5, 0.35, C(50, 54, 62));
        if (gold > 0.2) this.#circ(0, 3.5, 0.9, `rgba(255,214,120,${0.35 * gold})`);
        this.#circ(0, 3.5, 0.16, gold > 0.2 ? '#fff2b0' : C(220, 220, 200));
        break;
      }
      case 'stall': {
        const cols = [[220, 60, 60], [250, 230, 230], [60, 150, 220], [250, 240, 200]];
        this.#rect(-1.6, 0, 0.1, 2.6, C(120, 84, 52));
        this.#rect(1.5, 0, 0.1, 2.6, C(120, 84, 52));
        this.#rect(-1.6, 0, 3.2, 1, C(150, 108, 68));
        for (let i = 0; i < 6; i++) {
          const c = cols[(i + Math.floor(v * 3)) % 2 === 0 ? 0 : 1];
          this.#rect(-1.8 + i * 0.6, 2.4, 0.6, 0.55, C(c[0], c[1], c[2]));
        }
        for (let i = 0; i < 5; i++) this.#circ(-1.2 + i * 0.6, 1.2, 0.22, C(...[[230, 70, 60], [250, 190, 50], [120, 190, 70]][i % 3]));
        break;
      }
      case 'cow': {
        const bob = Math.sin(this.clock * 0.8 + v * 9) * 0.04;
        this.#ell(0, 1.2 + bob, 1.1, 0.62, C(245, 245, 245));
        this.#ell(-0.3, 1.3, 0.35, 0.3, C(40, 40, 44));
        this.#ell(0.4, 1.1, 0.3, 0.25, C(40, 40, 44));
        for (const lx of [-0.7, -0.3, 0.4, 0.8]) this.#rect(lx - 0.06, 0, 0.12, 0.8, C(230, 230, 230));
        this.#ell(1.25, 1.5, 0.3, 0.26, C(245, 245, 245));
        this.#rect(1.4, 1.35, 0.2, 0.12, C(240, 170, 170));
        break;
      }
      case 'boat': {
        const bob = Math.sin(this.clock * 1.2 + v * 8) * 0.12;
        this.#ell(0, -0.1 + bob, 2.4, 0.35, 'rgba(255,255,255,.18)');
        this.#poly([[-2, 0.3 + bob], [2, 0.3 + bob], [1.3, -0.2 + bob], [-1.3, -0.2 + bob]], C(250, 250, 250));
        this.#rect(-0.05, 0.3 + bob, 0.1, 5, C(120, 90, 60));
        this.#poly([[0.2, 0.5 + bob], [0.2, 5.1 + bob], [2.2, 0.6 + bob]], C(255, 255, 255));
        this.#poly([[-0.2, 0.7 + bob], [-0.2, 4 + bob], [-1.6, 0.8 + bob]], C(v > 0.5 ? 235 : 70, v > 0.5 ? 70 : 150, v > 0.5 ? 70 : 220));
        break;
      }
      default: break;
    }
  }

  #person(it) {
    const { ctx } = this;
    const v = it.v;
    const bounce = Math.abs(Math.sin(this.clock * 5 + v * 20)) * 0.25;
    const cols = [[230, 70, 80], [60, 140, 230], [250, 200, 60], [90, 190, 120], [200, 90, 220], [250, 250, 250]];
    const c = cols[Math.floor(v * cols.length)];
    ctx.save(); ctx.translate(0, bounce);
    this.#rect(-0.22, 0.2, 0.18, 0.7, 'rgb(40,44,60)');
    this.#rect(0.04, 0.2, 0.18, 0.7, 'rgb(40,44,60)');
    this.#rect(-0.3, 0.85, 0.6, 0.75, `rgb(${c[0]},${c[1]},${c[2]})`);
    this.#circ(0, 1.88, 0.22, 'rgb(232,184,148)');
    const wave = Math.sin(this.clock * 8 + v * 30) * 0.25;
    ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = 0.14; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-0.3, 1.5); ctx.lineTo(-0.55 - wave * 0.3, 2.3 + wave); ctx.moveTo(0.3, 1.5); ctx.lineTo(0.55 + wave * 0.3, 2.3 - wave); ctx.stroke();
    if (it.flag) {
      this.#rect(0.5, 1.6, 0.05, 1.5, 'rgb(220,220,220)');
      this.#poly([[0.55, 3.1], [1.5 + wave * 0.3, 2.8], [0.55, 2.5]], `rgb(${c[1]},${c[2]},${c[0]})`);
    }
    ctx.restore();
  }

  // ---- landmarks --------------------------------------------------------------------------

  #landmark(it, C) {
    const { ctx } = this;
    const t = this.clock;
    switch (it.lm.kind) {
      case 'windmill': {
        this.#poly([[-2.6, 0], [2.6, 0], [1.5, 9], [-1.5, 9]], C(236, 228, 210));
        this.#poly([[-2.6, 0], [-1.5, 9], [-0.3, 9], [-0.9, 0]], C(210, 200, 182));
        this.#poly([[-2, 9], [0, 11.5], [2, 9]], C(150, 76, 60));
        this.#rect(-0.5, 0, 1, 2, C(110, 76, 50));
        ctx.save(); ctx.translate(0, 8.4);
        ctx.rotate(t * 0.7);
        for (let k = 0; k < 4; k++) {
          ctx.rotate(Math.PI / 2);
          this.#rect(-0.12, 0.4, 0.24, 6.4, C(90, 62, 40));
          this.#rect(0.12, 1.4, 1.5, 5, C(250, 244, 230));
          ctx.strokeStyle = C(160, 130, 100); ctx.lineWidth = 0.05;
          for (let r = 0; r < 5; r++) { ctx.beginPath(); ctx.moveTo(0.12, 1.6 + r); ctx.lineTo(1.6, 1.6 + r); ctx.stroke(); }
        }
        ctx.restore();
        this.#circ(0, 8.4, 0.42, C(90, 62, 40));
        break;
      }
      case 'cabin': {
        this.#rect(-3, 0, 6, 3, C(138, 92, 56));
        for (let i = 0; i < 5; i++) this.#rect(-3, 0.5 + i * 0.55, 6, 0.06, C(100, 64, 38));
        this.#poly([[-3.6, 3], [0, 5.4], [3.6, 3]], C(86, 56, 40));
        this.#rect(1.5, 4, 0.7, 1.6, C(110, 100, 96));
        this.#rect(-0.5, 0, 1, 1.9, C(80, 50, 30));
        this.#rect(-2.4, 1.4, 1, 0.9, C(255, 214, 130));
        for (let i = 0; i < 4; i++) this.#circ(1.85 + Math.sin(t + i) * 0.3 + i * 0.25, 6 + ((t * 1.2 + i * 0.8) % 3.2), 0.35 + i * 0.12, `rgba(235,235,240,${0.55 - i * 0.12})`);
        break;
      }
      case 'castle': {
        this.#ell(0, 0, 38, 10, C(84, 142, 76));
        this.#ell(0, 3, 26, 8, C(96, 156, 84));
        const st = C(190, 186, 176), sd = C(160, 156, 148);
        this.#rect(-9, 7, 18, 11, st);
        for (let i = 0; i < 7; i++) this.#rect(-9 + i * 2.7, 18, 1.5, 1.2, st);
        this.#rect(-14, 7, 5, 18, sd);
        this.#rect(9, 7, 5, 18, sd);
        this.#poly([[-15, 25], [-11.5, 32], [-8, 25]], C(170, 60, 60));
        this.#poly([[8, 25], [11.5, 32], [15, 25]], C(170, 60, 60));
        this.#rect(-3, 18, 6, 10, st);
        this.#poly([[-4, 28], [0, 36], [4, 28]], C(170, 60, 60));
        this.#poly([[-2.4, 7], [-2.4, 11], [0, 13], [2.4, 11], [2.4, 7]], C(60, 50, 50));
        for (const [wx, wy] of [[-6, 14], [6, 14], [-11.5, 20], [11.5, 20], [0, 22]]) this.#rect(wx - 0.4, wy, 0.8, 1.6, C(70, 70, 90));
        const fw = Math.sin(t * 3) * 0.8;
        this.#rect(-0.05, 36, 0.1, 4, C(230, 230, 230));
        this.#poly([[0.05, 39.6], [3 + fw, 38.9], [0.05, 38.2]], C(230, 60, 80));
        break;
      }
      case 'lighthouse': {
        this.#poly([[-2.4, 0], [2.4, 0], [1.6, 16], [-1.6, 16]], C(248, 248, 248));
        for (let i = 0; i < 4; i += 2) {
          const y0 = i * 4, y1 = y0 + 4;
          const xl = (y) => -2.4 + (y / 16) * 0.8, xr = (y) => 2.4 - (y / 16) * 0.8;
          this.#poly([[xl(y0), y0], [xr(y0), y0], [xr(y1), y1], [xl(y1), y1]], C(206, 52, 52));
        }
        this.#rect(-2.2, 16, 4.4, 0.5, C(60, 60, 70));
        this.#rect(-1.2, 16.5, 2.4, 2, C(255, 232, 150));
        this.#poly([[-1.6, 18.5], [0, 20.5], [1.6, 18.5]], C(190, 50, 50));
        const sx = Math.cos(t * 1.3);
        const len = 70 * Math.abs(sx);
        const dir = sx < 0 ? -1 : 1;
        this.#circ(0, 17.5, 3, 'rgba(255,240,170,.35)');
        this.#poly([[0, 17.5], [dir * len, 19], [dir * len, 16]], 'rgba(255,245,190,.3)');
        break;
      }
      case 'church': {
        this.#rect(-6, 0, 11, 5, C(238, 230, 214));
        this.#poly([[-6.6, 5], [-0.5, 8.4], [5.6, 5]], C(150, 80, 66));
        this.#rect(-2, 0, 4, 11, C(244, 236, 220));
        this.#poly([[-2.7, 11], [0, 20], [2.7, 11]], C(110, 90, 100));
        this.#rect(-0.07, 20, 0.14, 1.8, C(230, 200, 90));
        this.#rect(-0.5, 20.9, 1, 0.14, C(230, 200, 90));
        this.#circ(0, 8, 0.9, C(250, 250, 250));
        this.#circ(0, 8, 0.65, C(210, 190, 120));
        this.#poly([[-0.9, 0], [-0.9, 2.2], [0, 3], [0.9, 2.2], [0.9, 0]], C(100, 66, 44));
        break;
      }
      case 'arch': this.#gantryBody(7, '#ff3b6b', true); break;
      case 'summit': this.#gantryBody(7, '#3a98f5', false); break;
      default: break;
    }
  }

  /** Overhead banner with bunting for start and summit (metre space). */
  #gantryBody(h, color, chequered) {
    const { ctx } = this;
    const hw = ROAD_HALF + 0.8;
    this.#rect(-hw - 0.2, 0, 0.4, h, 'rgb(225,228,236)');
    this.#rect(hw - 0.2, 0, 0.4, h, 'rgb(225,228,236)');
    this.#rect(-hw, h - 2, hw * 2, 2, color);
    if (chequered) for (let c = 0; c < 18; c++) this.#rect(-hw + c * (hw * 2 / 18), 0, hw * 2 / 18, 0.4, c % 2 ? '#fff' : '#111');
    const cols = ['#ff5a5f', '#ffd166', '#3fa9f5', '#6ee7b7', '#f472b6'];
    for (let i = 0; i < 12; i++) {
      const x = -hw + (i + 0.5) * (hw * 2 / 12);
      const sag = Math.sin((i / 11) * Math.PI) * 0.9;
      this.#poly([[x - 0.35, h - 2 - sag], [x + 0.35, h - 2 - sag], [x, h - 2.9 - sag]], cols[i % cols.length]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0)';
  }

  /** Text on the banner is drawn in screen space so it stays crisp. */
  #lmLabel(it, P) {
    const { ctx } = this;
    const p = P.sc;
    if (it.lm.kind === 'arch' || it.lm.kind === 'summit') {
      const txt = it.lm.kind === 'arch' ? 'START · FINISH' : 'SUMMIT 1,374 m';
      const hw = (ROAD_HALF + 0.8) * p;
      ctx.fillStyle = '#fff';
      let fs = 1.1 * p;
      ctx.font = `800 ${fs}px system-ui, sans-serif`;
      const tw = ctx.measureText(txt).width;
      if (tw > hw * 1.8) { fs *= (hw * 1.8) / tw; ctx.font = `800 ${fs}px system-ui, sans-serif`; }
      ctx.textAlign = 'center';
      ctx.fillText(txt, P.x, P.y - 5.4 * p);
      ctx.textAlign = 'start';
    } else if (it.lm.kind === 'tunnel' || it.lm.kind === 'bridge') {
      // no label; the structures speak for themselves
    }
  }

  // ---- tunnel and bridge ---------------------------------------------------------------------

  #rib(it, P) {
    const { ctx } = this;
    const z = P.z;
    const dark = clamp(z / 200, 0, 1);
    const rock = it.first ? [128, 128, 138] : [86, 88, 98];
    const col = this.#fc(mix(rock, [14, 16, 22], dark * 0.6), z);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.rect(-17, 0, 34, 15); // rock block
    const hw = ROAD_HALF + 0.9;
    ctx.moveTo(-hw, 0); ctx.lineTo(-hw, 3.8);
    ctx.ellipse(0, 3.8, hw, 2.1, 0, Math.PI, 0, true);
    ctx.lineTo(hw, 0); ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = this.#fc(mix(rock, [255, 255, 255], 0.35), z);
    ctx.lineWidth = 0.28;
    ctx.beginPath();
    ctx.moveTo(-hw, 0); ctx.lineTo(-hw, 3.8);
    ctx.ellipse(0, 3.8, hw, 2.1, 0, Math.PI, 0, true);
    ctx.lineTo(hw, 0);
    ctx.stroke();
    if (!it.first) { // ceiling lamps
      this.#circ(0, 5.5, 0.75, 'rgba(255,200,120,.28)');
      this.#circ(0, 5.5, 0.2, '#ffe9b0');
    } else {
      this.#rect(-hw - 0.4, 0, 0.4, 4.1, 'rgb(170,170,180)');
      this.#rect(hw, 0, 0.4, 4.1, 'rgb(170,170,180)');
    }
    void ctx;
  }

  #tunnelCore() {
    const hw = ROAD_HALF + 0.9;
    const { ctx } = this;
    ctx.fillStyle = 'rgb(10,12,18)';
    ctx.beginPath();
    ctx.moveTo(-hw, 0); ctx.lineTo(-hw, 3.8);
    ctx.ellipse(0, 3.8, hw, 2.1, 0, Math.PI, 0, true);
    ctx.lineTo(hw, 0); ctx.fill();
  }

  #tunnelExit() {
    const hw = ROAD_HALF + 0.9;
    const { ctx } = this;
    const g = ctx.createRadialGradient(0, 3, 0, 0, 3, hw * 1.3);
    g.addColorStop(0, 'rgba(255,255,245,1)');
    g.addColorStop(0.7, 'rgba(255,248,220,.95)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-hw, 0); ctx.lineTo(-hw, 3.8);
    ctx.ellipse(0, 3.8, hw, 2.1, 0, Math.PI, 0, true);
    ctx.lineTo(hw, 0); ctx.fill();
  }

  #bridgeFrame(it, C) {
    const hw = ROAD_HALF + 0.6;
    const wood = C(122, 82, 50), dark = C(90, 58, 36);
    this.#rect(-hw - 0.2, 0, 0.4, 6.4, wood);
    this.#rect(hw - 0.2, 0, 0.4, 6.4, wood);
    this.#rect(-hw - 0.2, 0, 0.4, 1.3, dark);
    this.#rect(hw - 0.2, 0, 0.4, 1.3, dark);
    this.#rect(-hw - 0.2, 1.2, hw * 2 + 0.4, 0.2, wood);
    this.#poly([[-hw - 0.7, 6.2], [0, 8.4], [hw + 0.7, 6.2], [hw + 0.7, 5.7], [0, 7.8], [-hw - 0.7, 5.7]], C(150, 62, 52));
    if (it.end) this.#poly([[-hw - 0.5, 5.7], [0, 7.8], [hw + 0.5, 5.7]], C(130, 90, 56));
  }

  // ---- screen-space signs and orbs -------------------------------------------------------------

  #gantry(P, text, color, isEnd, big) {
    const { ctx } = this;
    const p = P.sc;
    const hw = (ROAD_HALF + 0.5) * p;
    ctx.fillStyle = '#d9dde6';
    ctx.fillRect(P.x - hw - 0.15 * p, P.y - 5.4 * p, 0.3 * p, 5.4 * p);
    ctx.fillRect(P.x + hw - 0.15 * p, P.y - 5.4 * p, 0.3 * p, 5.4 * p);
    if (isEnd) {
      const cols = 12;
      const cw = (2 * ROAD_HALF * p) / cols;
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = c % 2 ? '#fff' : '#111';
        ctx.fillRect(P.x - ROAD_HALF * p + c * cw, P.y - 0.5 * p, cw, 0.5 * p);
      }
    }
    ctx.fillStyle = color;
    ctx.fillRect(P.x - hw, P.y - 5.6 * p, 2 * hw, 1.5 * p);
    ctx.fillStyle = '#fff';
    let fs = (big ? 1.2 : 1.0) * p;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    if (tw > hw * 1.9) { fs *= (hw * 1.9) / tw; ctx.font = `800 ${fs}px system-ui, sans-serif`; }
    ctx.textAlign = 'center';
    ctx.fillText(text, P.x, P.y - 4.5 * p);
    ctx.textAlign = 'start';
  }

  #orb(o, x, y, p, clock) {
    const { ctx } = this;
    const yy = y - o.h * p + Math.sin(clock * 3 + o.i) * 0.06 * p;
    const col = o.gold ? '255,200,40' : '80,200,255';
    const r = (o.gold ? 0.3 : 0.22) * p;
    const g = ctx.createRadialGradient(x, yy, 0, x, yy, r * 2.8);
    g.addColorStop(0, `rgba(${col},0.95)`);
    g.addColorStop(0.35, `rgba(${col},0.35)`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, yy, r * 2.8, 0, 7); ctx.fill();
    ctx.fillStyle = o.gold ? '#fff2b0' : '#d6f4ff';
    ctx.beginPath(); ctx.arc(x, yy, r * 0.6, 0, 7); ctx.fill();
  }

  // ---- riders (seen from behind) ----------------------------------------------------------------

  #rider(r, x, y, p, game) {
    const { ctx } = this;
    if (p * 1.8 < 6) return;
    const ratio = r.isUser ? clamp(game.pSmooth / game.profile.ftp, 0, 2) : 0.7;
    const rock = Math.sin(r.crank) * 0.03 * (0.6 + ratio); // sway with each pedal stroke
    const jersey = r.isCoach ? '#ffd400' : r.color;
    const frame = r.isUser ? '#e8e8ee' : '#2a2d36';
    const U = (mx) => x + (mx + rock * (mx === 0 ? 1 : 0.4)) * p; // lateral metres -> px
    const Y = (my) => y - my * p; // height metres -> px
    const line = (x1, y1, x2, y2, wd, c) => {
      ctx.strokeStyle = c; ctx.lineWidth = Math.max(1, wd * p);
      ctx.beginPath(); ctx.moveTo(U(x1), Y(y1)); ctx.lineTo(U(x2), Y(y2)); ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (r.isUser) { // zone-coloured aura
      const z = POWER_ZONES[game.pz];
      const rad = p * (1.6 + ratio * 0.9);
      const g = ctx.createRadialGradient(x, Y(1.0), 0, x, Y(1.0), rad);
      g.addColorStop(0, hexA(z.color, 0.1 + 0.28 * Math.min(ratio, 1.2)));
      g.addColorStop(1, hexA(z.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, Y(1.0), rad, 0, 7); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.beginPath(); ctx.ellipse(x, y, 0.5 * p, 0.12 * p, 0, 0, 7); ctx.fill();

    // rear tyre with moving tread
    ctx.fillStyle = '#14161b';
    ctx.beginPath(); ctx.roundRect(U(-0.04), Y(0.7), 0.08 * p, 0.7 * p, 0.04 * p); ctx.fill();
    ctx.strokeStyle = 'rgba(190,200,215,.55)'; ctx.lineWidth = Math.max(1, 0.012 * p);
    for (let k = 0; k < 7; k++) {
      const yy = 0.35 + 0.33 * Math.cos(r.wheel + (k * Math.PI) / 7);
      ctx.beginPath(); ctx.moveTo(U(-0.04), Y(yy)); ctx.lineTo(U(0.04), Y(yy)); ctx.stroke();
    }
    line(0, 0.34, 0, 0.95, 0.045, frame);
    line(-0.12, 0.34, 0, 0.9, 0.025, frame);
    line(0.12, 0.34, 0, 0.9, 0.025, frame);
    line(-0.08, 0.97, 0.08, 0.97, 0.05, '#111');
    line(-0.22, 1.03, 0.22, 1.03, 0.035, '#222');

    const leg = (side, ang, col) => {
      const hipx = side * 0.1, hipy = 0.93;
      const fx = side * 0.14, fy = 0.3 + 0.17 * Math.cos(ang);
      const kx = side * 0.19, ky = (hipy + fy) / 2 + 0.06 + 0.06 * Math.max(0, Math.cos(ang));
      line(hipx, hipy, kx, ky, 0.13, col);
      line(kx, ky, fx, fy + 0.04, 0.1, col);
      line(fx - 0.05, fy, fx + 0.05, fy, 0.05, '#eee');
    };
    leg(-1, r.crank, '#101218');
    leg(1, r.crank + Math.PI, '#1a1d26');

    ctx.fillStyle = jersey;
    ctx.beginPath();
    ctx.moveTo(U(-0.17), Y(0.95)); ctx.lineTo(U(0.17), Y(0.95));
    ctx.lineTo(U(0.22), Y(1.38)); ctx.lineTo(U(-0.22), Y(1.38));
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(U(-0.015), Y(1.36), 0.03 * p, 0.4 * p);
    line(-0.2, 1.34, -0.27, 1.19, 0.08, jersey);
    line(-0.27, 1.19, -0.2, 1.04, 0.07, jersey);
    line(0.2, 1.34, 0.27, 1.19, 0.08, jersey);
    line(0.27, 1.19, 0.2, 1.04, 0.07, jersey);
    ctx.fillStyle = '#e8b894';
    ctx.fillRect(U(-0.035), Y(1.45), 0.07 * p, 0.09 * p);
    ctx.beginPath(); ctx.arc(U(0), Y(1.53), 0.1 * p, 0, 7); ctx.fill();
    ctx.fillStyle = r.isUser ? '#fff' : '#222';
    ctx.beginPath(); ctx.ellipse(U(0), Y(1.57), 0.12 * p, 0.1 * p, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(U(-0.12), Y(1.57), 0.24 * p, 0.03 * p);

    if (r.isUser) {
      ctx.fillStyle = '#ff3b6b';
      const ty = Y(1.95);
      ctx.beginPath(); ctx.moveTo(x - 0.1 * p, ty - 0.2 * p); ctx.lineTo(x + 0.1 * p, ty - 0.2 * p); ctx.lineTo(x, ty); ctx.fill();
    } else if (r.isCoach || p > 14) {
      this.#nameTag(x, Y(1.95), r, p);
    }
  }

  #nameTag(x, y, r, p) {
    const { ctx } = this;
    const fs = clamp(0.2 * p, 10, 15);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const tw = ctx.measureText(r.name).width + fs;
    ctx.fillStyle = 'rgba(8,10,16,.65)';
    ctx.beginPath(); ctx.roundRect(x - tw / 2, y - fs * 1.1, tw, fs * 1.5, fs * 0.75); ctx.fill();
    ctx.fillStyle = r.isCoach ? '#ffd400' : '#fff';
    ctx.fillText(r.name, x, y);
    ctx.textAlign = 'start';
  }

  // ---- reactive effects ------------------------------------------------------------------------

  #effects(game, dt, R, hz, camLat) {
    const { ctx, w, h, f } = this;
    const u = this.u;
    const user = game.user;
    const P = this.#at(R, CAM_BACK, user.lat - camLat) || { x: w / 2, y: h * 0.75, sc: f / CAM_BACK };
    const ratio = game.pSmooth / game.profile.ftp;

    for (const e of this.pending) {
      const n = e.gold ? 24 : 12;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, sp = (60 + Math.random() * 200) * u;
        this.parts.push({ x: P.x, y: P.y - P.sc * 1.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60 * u, life: 0.6, max: 0.6, c: e.gold ? '255,210,60' : '90,210,255', s: 3.5 * u, g: 160 * u });
      }
    }
    this.pending = [];

    if (ratio > 1.3 && !game.paused) { // sprint sparks off the rear wheel
      for (let i = 0; i < 3; i++) {
        this.parts.push({
          x: P.x + (Math.random() - 0.5) * P.sc * 0.2, y: P.y - P.sc * 0.1, vx: (Math.random() - 0.5) * 260 * u, vy: -(60 + Math.random() * 220) * u,
          life: 0.55, max: 0.55, c: ratio > 1.8 ? '194,92,255' : '255,160,60', s: 2.8 * u, g: 500 * u,
        });
      }
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const q = this.parts[i];
      q.life -= dt;
      if (q.life <= 0) { this.parts.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.vy += q.g * dt;
      ctx.fillStyle = `rgba(${q.c},${q.life / q.max})`;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.s * (0.4 + q.life / q.max), 0, 7); ctx.fill();
    }

    // falling snow on the alpine pass
    if (this.env.snow > 0.12) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + this.env.snow * 0.45})`;
      for (const s of this.snow) {
        s.y += dt * (0.12 + 0.18 * s.s);
        s.x += dt * (0.02 + user.v * 0.004) * s.s * -1;
        if (s.y > 1) { s.y = 0; s.x = Math.random(); }
        if (s.x < 0) s.x += 1;
        ctx.beginPath(); ctx.arc(s.x * w, s.y * h, (1 + s.s * 1.6) * u, 0, 7); ctx.fill();
      }
    }

    // speed streaks rushing out from the vanishing point
    const k = clamp((user.v - 9) / 10, 0, 0.55);
    if (k > 0.02) {
      const t = game.clock * (0.8 + user.v * 0.05);
      const span = Math.max(w, h);
      ctx.strokeStyle = `rgba(255,255,255,${k * 0.5})`;
      ctx.lineWidth = 1.5 * u;
      for (let i = 0; i < 28; i++) {
        const a = hash(i) * TAU;
        if (Math.abs(Math.cos(a)) < 0.35) continue; // keep the centre of the road clear
        const ph = (t * (0.6 + hash(i + 3)) + hash(i + 9)) % 1;
        const r1 = (0.15 + ph * 0.7) * span;
        const r2 = r1 + (0.04 + ph * 0.1) * span;
        ctx.beginPath();
        ctx.moveTo(w / 2 + Math.cos(a) * r1, hz + Math.sin(a) * r1 * 0.6);
        ctx.lineTo(w / 2 + Math.cos(a) * r2, hz + Math.sin(a) * r2 * 0.6);
        ctx.stroke();
      }
    }
  }

  /** Golden-hour tint plus a screen-edge glow in the heart-rate zone that pulses with each beat. */
  #atmosphere(game) {
    const { ctx, w, h } = this;
    if (this.gold > 0.02) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `rgba(255,150,70,${0.1 * this.gold})`);
      g.addColorStop(1, `rgba(255,120,60,${0.16 * this.gold})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    if (game.hr != null && game.hz >= 0) {
      const zc = HR_ZONES[game.hz].color;
      const beat = ((game.clock * game.hr) / 60) % 1;
      const pulse = Math.exp(-beat * 6);
      const a = 0.08 + game.hz * 0.035 + pulse * (game.hz >= 3 ? 0.2 : 0.06);
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, hexA(zc, 0));
      g.addColorStop(1, hexA(zc, a));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
