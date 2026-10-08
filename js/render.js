// Third-person renderer: a pseudo-3D chase camera behind the rider. The road bends, rises and
// falls with the course; riders are seen from behind. Stat-driven effects sit on top.

import { elevation, SEGMENTS, LOOP, POWER_ZONES, HR_ZONES, clamp } from './physics.js';
import { orbAt, hash, ORB_SPACING } from './game.js';

const VEX = 2.4; // elevation exaggeration so hills read on screen
const SEG = 2.2; // road slice length (m)
const MAXZ = 260; // draw distance (m)
const CAM_BACK = 5.8; // camera sits this far behind the user (m)
const CAM_H = 1.8; // camera height above the road (m)
const ROAD_HALF = 4.2; // half road width (m)

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
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const hexA = (h, a) => rgb(hex(h), a);

function skyAt(tod) {
  for (let i = 1; i < SKY.length; i++) {
    if (tod <= SKY[i][0]) {
      const k = (tod - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
      return [mix(hex(SKY[i - 1][1]), hex(SKY[i][1]), k), mix(hex(SKY[i - 1][2]), hex(SKY[i][2]), k)];
    }
  }
  return [hex(SKY[0][1]), hex(SKY[0][2])];
}

// ---- road curvature (visual only) ------------------------------------------------
const A = 0.0011;
const TAU = Math.PI * 2;
const curvature = (X) => A * (Math.sin((TAU * X) / 700) + 0.7 * Math.sin((TAU * X) / 290 + 1.3));
/** Integral of curvature: the road's compass heading, used to pan the backdrop. */
const heading = (X) => A * (-(700 / TAU) * Math.cos((TAU * X) / 700) - 0.7 * (290 / TAU) * Math.cos((TAU * X) / 290 + 1.3));

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.parts = [];
    this.pending = [];
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
    const hz = h * 0.4;
    const tod = (0.14 + game.clock / 1500) % 1;
    const night = clamp(1 - Math.abs(tod - 0.9) / 0.14, 0, 1);
    this.u = Math.min(w / 1400, h / 800);

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
    const bgShift = heading(camX) * w * 2.2;

    this.#sky(tod, night, bgShift, game.clock, hz);
    this.#hills(bgShift, hz, night);
    this.ctx.fillStyle = '#2f7a43';
    this.ctx.fillRect(0, hz, w, h - hz);

    const R = this.#project(camX, hz, camLat);
    this.#road(R, night);
    this.#sprites(R, game, camX, camLat, night);
    this.#effects(game, dt, R, hz, camLat);
    this.#vignette(game, night);
  }

  // ---- backdrop -----------------------------------------------------------------

  #sky(tod, night, shift, clock, hz) {
    const { ctx, w } = this;
    const [top, bot] = skyAt(tod);
    const g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, rgb(top));
    g.addColorStop(1, rgb(bot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hz + 2);

    if (night > 0.05) {
      ctx.fillStyle = `rgba(255,255,255,${night * 0.8})`;
      for (let i = 0; i < 70; i++) ctx.fillRect(hash(i) * w, hash(i + 99) * hz * 0.85, 1.5, 1.5);
    }
    if (tod < 0.8) {
      const k = tod / 0.8;
      this.#glow(w * (0.08 + 0.84 * k) - shift * 0.1, hz * 0.8 - Math.sin(Math.PI * k) * hz * 0.6, hz * 0.07, '255,230,160');
    } else {
      this.#glow(w * (0.2 + 0.6 * ((tod - 0.8) / 0.2)), hz * 0.3, hz * 0.04, '220,230,255');
    }
    ctx.fillStyle = `rgba(255,255,255,${0.55 - night * 0.4})`;
    for (let i = 0; i < 7; i++) {
      const span = w * 1.6;
      const x = ((((hash(i * 7) * span - shift * 0.25 - clock * 5) % span) + span) % span) - w * 0.3;
      const y = hz * (0.08 + hash(i * 3) * 0.55);
      const s = (45 + hash(i) * 55) * (w / 1400);
      for (const [dx, dy, r] of [[0, 0, 1], [0.8, 0.15, 0.7], [-0.8, 0.2, 0.65], [0.3, -0.3, 0.7]]) {
        ctx.beginPath();
        ctx.ellipse(x + dx * s, y + dy * s, s * r * 1.1, s * r * 0.55, 0, 0, 7);
        ctx.fill();
      }
    }
  }

  #glow(x, y, r, c) {
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, `rgba(${c},1)`);
    g.addColorStop(0.25, `rgba(${c},0.8)`);
    g.addColorStop(1, `rgba(${c},0)`);
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r * 4, 0, 7);
    this.ctx.fill();
  }

  #hills(shift, hz, night) {
    const { ctx, w } = this;
    const u = this.u;
    const layers = [
      { par: 0.35, lift: 0.1, amp: 110, col: [96, 120, 165] },
      { par: 0.6, lift: 0.04, amp: 70, col: [70, 120, 120] },
      { par: 1.0, lift: 0.0, amp: 40, col: [52, 128, 84] },
    ];
    layers.forEach((L, li) => {
      ctx.fillStyle = rgb(mix(L.col, [10, 14, 30], night * 0.7));
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

  // ---- road ----------------------------------------------------------------------

  /** Project road slices ahead of the camera into screen space. */
  #project(camX, hz, camLat) {
    const { w, f } = this;
    const first = Math.floor(camX / SEG) + 1;
    const N = Math.ceil(MAXZ / SEG);
    const R = { X: [], z: [], y: [], x: [], sc: [], vis: [], N };
    let hd = 0;
    let lat = 0;
    let zPrev = 0;
    for (let j = 0; j <= N; j++) {
      const X = j === 0 ? camX + 0.9 : (first + j - 1) * SEG;
      const z = j === 0 ? 0.9 : Math.max(X - camX, zPrev + 0.05);
      hd += curvature(X) * (z - zPrev);
      lat += hd * (z - zPrev);
      zPrev = z;
      const sc = f / z;
      R.X.push(X);
      R.z.push(z);
      R.sc.push(sc);
      R.y.push(hz + (CAM_H - (elevation(X) - this.camE) * VEX) * sc);
      R.x.push(w / 2 + (lat - camLat) * sc);
    }
    let clip = Infinity; // slices hidden behind a nearer crest are skipped
    for (let j = 0; j < N; j++) {
      R.vis.push(R.y[j + 1] < clip);
      clip = Math.min(clip, R.y[j + 1]);
    }
    return R;
  }

  #road(R, night) {
    const { ctx, w } = this;
    const dim = 1 - night * 0.55;
    const shade = (c) => `rgb(${Math.round(c[0] * dim)},${Math.round(c[1] * dim)},${Math.round(c[2] * dim)})`;
    const quad = (j, a, b) => {
      const hw0 = ROAD_HALF * R.sc[j], hw1 = ROAD_HALF * R.sc[j + 1];
      ctx.beginPath();
      ctx.moveTo(R.x[j] + a * hw0, R.y[j]); ctx.lineTo(R.x[j] + b * hw0, R.y[j]);
      ctx.lineTo(R.x[j + 1] + b * hw1, R.y[j + 1]); ctx.lineTo(R.x[j + 1] + a * hw1, R.y[j + 1]);
      ctx.fill();
    };
    for (let j = R.N - 1; j >= 0; j--) {
      if (!R.vis[j]) continue;
      const y0 = R.y[j], y1 = R.y[j + 1];
      if (y0 < y1) continue; // faces away
      const stripe = Math.floor(R.X[j + 1] / SEG);
      ctx.fillStyle = shade(stripe % 2 ? [49, 128, 70] : [44, 118, 64]);
      ctx.fillRect(0, y1, w, y0 - y1 + 1);
      ctx.fillStyle = shade(Math.floor(stripe / 2) % 2 ? [220, 60, 60] : [235, 235, 235]);
      quad(j, -1.12, -1);
      quad(j, 1, 1.12);
      ctx.fillStyle = shade(stripe % 2 ? [74, 79, 92] : [68, 73, 86]);
      quad(j, -1, 1);
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      quad(j, -0.93, -0.9);
      quad(j, 0.9, 0.93);
      if (Math.floor(R.X[j] / (SEG * 2)) % 2 === 0) quad(j, -0.012, 0.012);
      const ph = ((R.X[j] % LOOP) + LOOP) % LOOP;
      const seg = SEGMENTS.find((s) => ph >= s.start && ph < s.end);
      if (seg) {
        ctx.fillStyle = hexA(seg.color, 0.55);
        quad(j, -0.9, -0.8);
        quad(j, 0.8, 0.9);
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
    return { x: lerp(R.x) + lat * sc, y: lerp(R.y), sc };
  }

  // ---- sprites (scenery, banners, orbs, riders) --------------------------------------

  #sprites(R, game, camX, camLat, night) {
    const dim = 1 - night * 0.6;
    const list = [];
    const zOf = (X) => X - camX;

    const cell = 13;
    const c0 = Math.floor(camX / cell);
    for (let c = c0; c < c0 + MAXZ / cell; c++) {
      for (const side of [-1, 1]) {
        if (hash(c * 1.7 + side * 0.37) > 0.6) continue;
        const X = c * cell + hash(c * 2.3 + side) * 10;
        const lat = side * (6 + hash(c * 3.3 + side) * 13);
        list.push({ z: zOf(X), lat, kind: 'scenery', k: hash(c * 5.1 + side), s: 0.8 + hash(c * 9.3 + side) * 0.7 });
      }
    }
    const base = Math.floor(camX / LOOP) * LOOP;
    for (const s of SEGMENTS) {
      for (const k of [-1, 0, 1]) {
        for (const [off, isEnd] of [[s.start, false], [s.end, true]]) {
          const X = base + k * LOOP + off;
          if (X > camX && X < camX + MAXZ) list.push({ z: zOf(X), lat: 0, kind: 'gantry', seg: s, end: isEnd });
        }
      }
    }
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

    for (const it of list) {
      const P = this.#at(R, it.z, it.lat - camLat);
      if (!P) continue;
      if (it.kind === 'scenery') this.#scenery(it, P.x, P.y, P.sc, dim);
      else if (it.kind === 'gantry') this.#gantry(it, P);
      else if (it.kind === 'orb') this.#orb(it.o, P.x, P.y, P.sc, game.clock);
      else this.#rider(it.r, P.x, P.y, P.sc, game);
    }
  }

  #scenery(it, x, y, p, dim) {
    const { ctx } = this;
    const s = it.s;
    if (p * 8 < 3) return;
    ctx.save();
    ctx.translate(x, y);
    const k = it.k;
    if (k < 0.4) { // round tree
      ctx.fillStyle = `rgb(${90 * dim},${60 * dim},${40 * dim})`;
      ctx.fillRect(-0.25 * p * s, -2.8 * p * s, 0.5 * p * s, 2.8 * p * s);
      ctx.fillStyle = `rgb(${50 * dim},${135 * dim},${70 * dim})`;
      for (const [dx, dy, r] of [[0, 4.6, 2.3], [-1.6, 3.4, 1.7], [1.6, 3.4, 1.7]]) {
        ctx.beginPath(); ctx.arc(dx * p * s, -dy * p * s, r * p * s, 0, 7); ctx.fill();
      }
    } else if (k < 0.75) { // pine
      ctx.fillStyle = `rgb(${70 * dim},${50 * dim},${35 * dim})`;
      ctx.fillRect(-0.2 * p * s, -1.6 * p * s, 0.4 * p * s, 1.6 * p * s);
      ctx.fillStyle = `rgb(${30 * dim},${100 * dim},${70 * dim})`;
      for (let i = 0; i < 3; i++) {
        const yy = 1.4 + i * 2.2;
        ctx.beginPath();
        ctx.moveTo(-(2.6 - i * 0.5) * p * s, -yy * p * s); ctx.lineTo(0, -(yy + 3.6) * p * s); ctx.lineTo((2.6 - i * 0.5) * p * s, -yy * p * s);
        ctx.fill();
      }
    } else if (k < 0.93) { // bush
      ctx.fillStyle = `rgb(${60 * dim},${150 * dim},${80 * dim})`;
      ctx.beginPath(); ctx.ellipse(0, -0.6 * p * s, 1.5 * p * s, 0.9 * p * s, 0, 0, 7); ctx.fill();
    } else { // little house
      ctx.fillStyle = `rgb(${220 * dim},${200 * dim},${170 * dim})`;
      ctx.fillRect(-2.6 * p, -3.4 * p, 5.2 * p, 3.4 * p);
      ctx.fillStyle = `rgb(${170 * dim},${70 * dim},${60 * dim})`;
      ctx.beginPath(); ctx.moveTo(-3.1 * p, -3.4 * p); ctx.lineTo(0, -5.6 * p); ctx.lineTo(3.1 * p, -3.4 * p); ctx.fill();
      ctx.fillStyle = `rgb(${120 * dim},${180 * dim},${220 * dim})`;
      ctx.fillRect(-1.6 * p, -2.5 * p, 1 * p, 1 * p);
      ctx.fillRect(0.6 * p, -2.5 * p, 1 * p, 1 * p);
    }
    ctx.restore();
  }

  #gantry(it, P) {
    const { ctx } = this;
    const p = P.sc;
    const hw = (ROAD_HALF + 0.5) * p;
    ctx.fillStyle = '#d9dde6';
    ctx.fillRect(P.x - hw - 0.15 * p, P.y - 5.4 * p, 0.3 * p, 5.4 * p);
    ctx.fillRect(P.x + hw - 0.15 * p, P.y - 5.4 * p, 0.3 * p, 5.4 * p);
    if (it.end) { // chequered strip across the road
      const cols = 12;
      const cw = (2 * ROAD_HALF * p) / cols;
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = c % 2 ? '#fff' : '#111';
        ctx.fillRect(P.x - ROAD_HALF * p + c * cw, P.y - 0.5 * p, cw, 0.5 * p);
      }
    }
    ctx.fillStyle = it.seg.color;
    ctx.fillRect(P.x - hw, P.y - 5.6 * p, 2 * hw, 1.5 * p);
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${1.0 * p}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(it.end ? 'FINISH' : it.seg.name.toUpperCase(), P.x, P.y - 4.5 * p);
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

  // ---- riders (seen from behind) ----------------------------------------------------

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

  // ---- reactive effects -----------------------------------------------------------

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

  /** Screen edges glow in the heart-rate zone colour and pulse with the actual heartbeat. */
  #vignette(game, night) {
    const { ctx, w, h } = this;
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
    if (night > 0.2) { ctx.fillStyle = `rgba(5,8,25,${night * 0.25})`; ctx.fillRect(0, 0, w, h); }
  }
}
