// DOM heads-up display, workout/power graph, mini-map, toasts and the summary screen.

import {
  POWER_ZONES, HR_ZONES, SEGMENTS, LOOP, elevation, powerZone, levelFor, levelTitle, xpForLevel, fmtTime, clamp,
} from './physics.js';
import { MAP, LANDMARKS, BIOMES, biomeIndex, posAt, gradeAt } from './course.js';
import { totalDuration } from './workouts.js';
import { ACHIEVEMENTS } from './achievements.js';

const $ = (id) => document.getElementById(id);
const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };

export function drawWorkoutProfile(canvas, workout, ftp, { playhead = null, samples = null } = {}) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (!workout.steps.length) {
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '14px system-ui';
    ctx.fillText('Free ride: no targets', 12, h / 2 + 5);
    return;
  }
  const dur = totalDuration(workout);
  const maxPct = Math.max(1.3, ...workout.steps.map((s) => Math.max(s.from, s.to))) * 1.08;
  const X = (t) => (t / dur) * w;
  const Y = (watts) => h - (watts / (maxPct * ftp)) * (h - 4);
  let t = 0;
  for (const s of workout.steps) {
    const col = POWER_ZONES[powerZone(((s.from + s.to) / 2) * ftp, ftp)].color;
    ctx.fillStyle = col + (playhead != null && t + s.dur < playhead ? '55' : 'cc');
    ctx.beginPath();
    ctx.moveTo(X(t), h); ctx.lineTo(X(t), Y(s.from * ftp)); ctx.lineTo(X(t + s.dur), Y(s.to * ftp)); ctx.lineTo(X(t + s.dur), h);
    ctx.fill();
    t += s.dur;
  }
  if (samples && samples.length) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((s, i) => (i ? ctx.lineTo(X(i), Y(s.p)) : ctx.moveTo(X(i), Y(s.p))));
    ctx.stroke();
  }
  if (playhead != null) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(X(playhead) - 1, 0, 2, h);
  }
}

function drawRecent(canvas, game) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const N = 300;
  const s = game.samples.slice(-N);
  const ftp = game.profile.ftp;
  const max = Math.max(ftp * 1.5, ...s.map((x) => x.p)) * 1.05;
  const Y = (v) => h - (v / max) * (h - 4);
  // zone bands
  let lo = 0;
  POWER_ZONES.forEach((z) => {
    const hi = Math.min(z.max * ftp, max);
    if (lo >= max) return;
    ctx.fillStyle = z.color + '18';
    ctx.fillRect(0, Y(hi), w, Y(lo) - Y(hi));
    lo = hi;
  });
  if (!s.length) return;
  ctx.beginPath();
  s.forEach((x, i) => { const px = (i / (N - 1)) * w + (N - s.length) / (N - 1) * w; i ? ctx.lineTo(px, Y(x.p)) : ctx.moveTo(px, Y(x.p)); });
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
}

export class Hud {
  constructor() {
    this.el = {};
    for (const id of ['h-power', 'h-pzone', 'h-zonebar', 'h-cad', 'h-hr', 'h-hrz', 'h-speed', 'h-wkg', 'h-time', 'h-dist', 'h-grade', 'h-kj',
      'h-draft', 'h-pause', 'h-board', 'h-mini', 'h-seg', 'h-seg-name', 'h-seg-bar', 'h-seg-time', 'h-score', 'h-mult', 'h-multbar',
      'h-level', 'h-xpbar', 'h-step', 'h-next', 'h-target', 'h-twatts', 'h-remain', 'h-graph', 'h-wait', 'h-sim', 'h-map', 'h-mapnote', 'h-zone']) this.el[id] = $(id);
    this.mapZoom = false;
    $('h-mapbox').addEventListener('click', () => { this.mapZoom = !this.mapZoom; $('h-mapbox').classList.toggle('zoomed', this.mapZoom); });
    this.el['h-zonebar'].innerHTML = POWER_ZONES.map(() => '<i></i>').join('');
    this.zoneBars = [...this.el['h-zonebar'].children];
    POWER_ZONES.forEach((z, i) => { this.zoneBars[i].style.background = z.color; });
    this.lastBeat = -1;
    this.lastMult = 1;
    this.graphAt = 0;
    this.boardAt = 0;
  }

  update(game, simActive) {
    const e = this.el;
    const { ftp, weight, maxHr } = game.profile;
    setText(e['h-power'], String(Math.round(game.p3)));
    const z = POWER_ZONES[powerZone(game.p3, ftp)];
    setText(e['h-pzone'], z.name);
    e['h-pzone'].style.background = z.color;
    e['h-power'].style.color = z.color;
    const zi = POWER_ZONES.indexOf(z);
    this.zoneBars.forEach((b, i) => b.classList.toggle('on', i === zi));

    setText(e['h-cad'], game.cad ? String(Math.round(game.cad)) : '--');
    setText(e['h-hr'], game.hr != null ? String(Math.round(game.hr)) : '--');
    const hz = game.hz;
    setText(e['h-hrz'], hz >= 0 ? `Z${hz + 1}` : '');
    if (hz >= 0) e['h-hrz'].style.background = HR_ZONES[hz].color;
    if (game.hr != null) { // pulse the number on every beat
      const beat = Math.floor((game.clock * game.hr) / 60);
      if (beat !== this.lastBeat) {
        this.lastBeat = beat;
        const p = e['h-hr'].parentElement;
        p.classList.remove('beat'); void p.offsetWidth; p.classList.add('beat');
      }
    }
    setText(e['h-speed'], (game.user.v * 3.6).toFixed(1));
    setText(e['h-wkg'], (game.p3 / weight).toFixed(1));
    setText(e['h-time'], fmtTime(game.t));
    setText(e['h-dist'], `${(game.distance / 1000).toFixed(2)} km`);
    setText(e['h-grade'], `${(game.grade * 100).toFixed(1)}%`);
    setText(e['h-kj'], `${Math.round(game.energy / 1000)} kJ`);
    e['h-draft'].hidden = !game.user.drafting;
    e['h-pause'].hidden = true;
    const waiting = !game.started || (game.paused && !game.finished);
    e['h-wait'].hidden = !waiting;
    setText(e['h-wait'], game.started ? 'Paused · pedal to resume' : 'Start pedalling to begin');
    e['h-sim'].hidden = !simActive;

    // score & combo
    setText(e['h-score'], String(Math.floor(game.score)).replace(/\B(?=(\d{3})+$)/g, ','));
    setText(e['h-mult'], `x${game.mult}`);
    const into = game.mult >= 5 ? 1 : (game.streak % 30) / 30;
    e['h-multbar'].style.width = `${into * 100}%`;
    if (game.mult !== this.lastMult) {
      this.lastMult = game.mult;
      const m = e['h-mult'].parentElement; m.classList.remove('hot'); void m.offsetWidth; m.classList.add('hot');
    }
    const xp = game.totalXp;
    const lvl = levelFor(xp);
    setText(e['h-level'], `Lv ${lvl}`);
    e['h-xpbar'].style.width = `${((xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl))) * 100}%`;

    this.#workout(game);
    if (game.clock - this.boardAt > 0.2) { this.boardAt = game.clock; this.#board(game); }
    this.#segment(game);
    this.#mini(game);
    this.#map(game);
    this.#zone(game);
    if (game.clock - this.graphAt > 0.5) {
      this.graphAt = game.clock;
      if (game.workout.steps.length) drawWorkoutProfile(e['h-graph'], game.workout, ftp, { playhead: game.wt, samples: game.samples });
      else drawRecent(e['h-graph'], game);
    }
    void maxHr;
  }

  #workout(game) {
    const e = this.el;
    const w = game.wo;
    const tg = e['h-target'];
    if (!game.workout.steps.length) {
      setText(e['h-step'], 'Free ride');
      setText(e['h-next'], 'Last 5 minutes of power');
      setText(e['h-remain'], '');
      tg.hidden = true;
      return;
    }
    if (!w) {
      setText(e['h-step'], game.workout.name);
      setText(e['h-next'], 'Start pedalling');
      return;
    }
    tg.hidden = !game.target;
    setText(e['h-step'], game.finished ? 'Workout complete' : (w.step.label || 'Interval'));
    setText(e['h-next'], w.next ? `Next: ${w.next.label || 'Interval'} ${Math.round(w.next.from * game.profile.ftp)} W · ${fmtTime(w.next.dur)}` : 'Last interval');
    setText(e['h-remain'], fmtTime(w.remaining));
    if (game.target) {
      setText(e['h-twatts'], String(game.target.watts));
      const d = game.p3 - game.target.watts;
      tg.classList.toggle('on', Math.abs(d) <= game.target.tol);
      tg.classList.toggle('low', d < -game.target.tol);
      tg.classList.toggle('high', d > game.target.tol);
    }
  }

  #board(game) {
    const rows = game.board().slice(0, 10);
    this.el['h-board'].innerHTML = rows.map(({ r, gap }, i) => {
      const g = r.isUser ? '' : `${gap > 0 ? '+' : '−'}${Math.abs(gap) < 100 ? Math.abs(gap).toFixed(0) : (Math.abs(gap) / 1000).toFixed(2) + 'k'}${Math.abs(gap) < 100 ? ' m' : ''}`;
      return `<div class="row ${r.isUser ? 'me' : ''}"><span>${i + 1}</span><span class="sw" style="background:${r.isCoach ? '#ffd400' : r.color}"></span><span>${r.name}</span><span class="gap">${r.isUser ? Math.round(game.p3) + ' W' : g}</span></div>`;
    }).join('');
  }

  #segment(game) {
    const e = this.el;
    const c = game.curSeg;
    e['h-seg'].hidden = !c;
    if (!c) return;
    setText(e['h-seg-name'], c.seg.name);
    e['h-seg-bar'].style.width = `${c.progress * 100}%`;
    setText(e['h-seg-time'], `${c.elapsed.toFixed(1)}s`);
  }

  #zone(game) {
    const phase = ((game.user.x % LOOP) + LOOP) % LOOP;
    const bi = biomeIndex(phase);
    let best = null;
    for (const lm of LANDMARKS) {
      const dist = (lm.d - phase + LOOP) % LOOP;
      if (dist > 15 && (!best || dist < best.dist)) best = { lm, dist };
    }
    const found = best && game.progress.discovered[best.lm.id];
    const dTxt = best ? (best.dist < 1000 ? `${Math.round(best.dist / 10) * 10} m` : `${(best.dist / 1000).toFixed(1)} km`) : '';
    setText(this.el['h-zone'], `📍 ${BIOMES[bi].name} · ${Math.round(elevation(game.user.x))} m${best ? `   ·   Next: ${found ? `${best.lm.emoji} ${best.lm.name}` : '❔ unknown landmark'} in ${dTxt}` : ''}`);
  }

  /** Elevation strip: zone colours, segments, landmarks and every rider. */
  #mini(game) {
    const cv = this.el['h-mini'];
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    ctx.clearRect(0, 0, w, h);
    const pad = 16;
    const X = (d) => pad + ((((d % LOOP) + LOOP) % LOOP) / LOOP) * (w - pad * 2);
    if (!this.profile) {
      this.profile = [];
      for (let d = 0; d <= LOOP; d += 50) this.profile.push([d, elevation(d)]);
      this.emin = Math.min(...this.profile.map((p) => p[1]));
      this.emax = Math.max(...this.profile.map((p) => p[1]));
    }
    const top = 26, bottom = h - 12;
    const Y = (el) => bottom - ((el - this.emin) / (this.emax - this.emin)) * (bottom - top);
    for (const b of BIOMES) { // zone colour band
      ctx.fillStyle = `rgb(${b.ground.map(Math.round)})`;
      ctx.fillRect(X(b.start), bottom + 3, X(b.end) - X(b.start), 5);
    }
    ctx.beginPath();
    ctx.moveTo(pad, bottom + 2);
    this.profile.forEach(([d, el]) => ctx.lineTo(pad + (d / LOOP) * (w - pad * 2), Y(el)));
    ctx.lineTo(w - pad, bottom + 2);
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, 'rgba(255,255,255,.3)');
    g.addColorStop(1, 'rgba(255,255,255,.06)');
    ctx.fillStyle = g;
    ctx.fill();
    for (const s of SEGMENTS) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let d = s.start; d <= s.end; d += 50) { const x = X(d), y = Y(elevation(d)); d === s.start ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.font = '14px system-ui, "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    for (const lm of LANDMARKS) {
      const x = X(lm.d), y = Y(elevation(lm.d));
      if (game.progress.discovered[lm.id]) ctx.fillText(lm.emoji, x, Math.max(14, y - 6));
      else { ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText('?', x, Math.max(14, y - 6)); }
    }
    ctx.textAlign = 'start';
    for (const { r } of game.board().slice().reverse()) {
      ctx.fillStyle = r.isCoach ? '#ffd400' : r.color;
      ctx.beginPath(); ctx.arc(X(r.x), Y(elevation(r.x)), r.isUser ? 5.5 : 3.5, 0, 7); ctx.fill();
      if (r.isUser) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
    }
  }

  /** Top-down map of the loop, coloured by gradient. Click to zoom and follow the rider. */
  #map(game) {
    const cv = this.el['h-map'];
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    ctx.clearRect(0, 0, w, h);
    const pad = 34;
    const fit = Math.min((w - pad * 2) / (MAP.maxX - MAP.minX), (h - pad * 2) / (MAP.maxY - MAP.minY));
    const me = posAt(game.user.x);
    const s = this.mapZoom ? fit * 3.4 : fit;
    const cx = this.mapZoom ? me.x : (MAP.minX + MAP.maxX) / 2;
    const cy = this.mapZoom ? me.y : (MAP.minY + MAP.maxY) / 2;
    const P = (x, y) => [w / 2 + (x - cx) * s, h / 2 - (y - cy) * s];
    ctx.save();
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 24); ctx.clip();
    ctx.fillStyle = 'rgba(30,60,50,.35)'; ctx.fillRect(0, 0, w, h);

    // lake
    const lake = posAt(7600);
    const [lx, ly] = P(lake.x - 230, lake.y);
    ctx.fillStyle = 'rgba(70,150,220,.5)';
    ctx.beginPath(); ctx.ellipse(lx, ly, 150 * s * 0.85, 95 * s * 0.85, 0.4, 0, 7); ctx.fill();

    const colour = (g) => (g < -0.025 ? '#6fb8ff' : g < 0.02 ? '#8fdc8a' : g < 0.045 ? '#f5d04a' : g < 0.07 ? '#ff9f2e' : '#ff4d4d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const trace = (from, to) => {
      ctx.beginPath();
      let first = true;
      for (const p of MAP.pts) {
        if (p.d < from || p.d > to) continue;
        const [x, y] = P(p.x, p.y);
        first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
      }
    };
    trace(0, 10000); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 9; ctx.stroke();
    for (const sg of SEGMENTS) { trace(sg.start, sg.end); ctx.strokeStyle = sg.color; ctx.lineWidth = 9; ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1; }
    for (let i = 1; i < MAP.pts.length; i++) {
      const a = MAP.pts[i - 1], b = MAP.pts[i];
      const [x0, y0] = P(a.x, a.y), [x1, y1] = P(b.x, b.y);
      ctx.strokeStyle = colour(gradeAt(b.d % LOOP)); ctx.lineWidth = 4.5;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }

    ctx.font = `${this.mapZoom ? 24 : 20}px system-ui, "Apple Color Emoji", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const lm of LANDMARKS) {
      const q = posAt(lm.d);
      const [x, y] = P(q.x, q.y);
      if (game.progress.discovered[lm.id]) ctx.fillText(lm.emoji, x, y - 12);
      else { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText('?', x, y - 11); }
    }
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';

    for (const { r } of game.board().slice().reverse()) {
      if (r.isUser) continue;
      const q = posAt(r.x);
      const [x, y] = P(q.x, q.y);
      ctx.fillStyle = r.isCoach ? '#ffd400' : r.color;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    }
    const [ux, uy] = P(me.x, me.y);
    const pulse = (game.clock * 1.2) % 1;
    ctx.strokeStyle = `rgba(255,59,107,${1 - pulse})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(ux, uy, 9 + pulse * 18, 0, 7); ctx.stroke();
    ctx.fillStyle = '#ff3b6b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(ux, uy, 9, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '700 18px system-ui, sans-serif';
    ctx.fillText('N ↑', 16, 28);
    ctx.restore();
    setText(this.el['h-mapnote'], this.mapZoom ? 'Following · click to zoom out' : `${Object.keys(game.progress.discovered).length}/${LANDMARKS.length} landmarks · click to zoom`);
  }
}

// ---- Toasts -------------------------------------------------------------------

export function toast({ text, sub, kind }) {
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.innerHTML = `<b></b><span></span>`;
  el.firstChild.textContent = text;
  el.lastChild.textContent = sub || '';
  host.appendChild(el);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => el.remove(), 3500);
}

// ---- Summary ------------------------------------------------------------------

export function showSummary(game, levelBefore, xpBefore) {
  const sum = game.summary();
  const stat = (v, label) => `<div><b>${v}</b><small>${label}</small></div>`;
  $('s-title').textContent = sum.completed ? 'Workout complete 🎉' : 'Ride complete';
  $('s-stats').innerHTML = [
    stat(fmtTime(sum.time), 'Time'),
    stat((sum.distance / 1000).toFixed(1) + ' km', 'Virtual distance'),
    stat(Math.round(sum.avgPower) + ' W', 'Avg power'),
    stat(Math.round(sum.maxP5) + ' W', 'Best 5 s'),
    stat(sum.avgHr ? Math.round(sum.avgHr) + ' bpm' : '--', 'Avg HR'),
    stat(sum.maxHr ? sum.maxHr + ' bpm' : '--', 'Max HR'),
    stat(Math.round(sum.kj) + ' kJ', 'Work'),
    stat(sum.score.toLocaleString(), 'Points'),
  ].join('');

  const canvas = $('s-chart');
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const s = sum.samples;
  if (s.length > 1) {
    if (sum.workout.steps.length) drawWorkoutProfile(canvas, sum.workout, game.profile.ftp, { samples: s });
    else {
      const maxP = Math.max(game.profile.ftp * 1.4, ...s.map((x) => x.p));
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
      s.forEach((x, i) => { const px = (i / (s.length - 1)) * w, py = h - (x.p / maxP) * (h - 10); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    }
    if (s.some((x) => x.hr)) {
      const minH = 60, maxH = game.profile.maxHr;
      ctx.strokeStyle = '#ff4d4d'; ctx.lineWidth = 2; ctx.beginPath();
      let first = true;
      s.forEach((x, i) => {
        if (!x.hr) return;
        const px = (i / (s.length - 1)) * w, py = h - clamp((x.hr - minH) / (maxH - minH), 0, 1) * (h - 10) - 4;
        first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false;
      });
      ctx.stroke();
    }
  }

  const zoneRows = (zones, secs) => {
    const total = secs.reduce((a, b) => a + b, 0) || 1;
    return zones.map((z, i) => `<div class="zrow" style="--c:${z.color}"><span>${z.name}</span><div class="bar"><i style="width:${(secs[i] / total) * 100}%"></i></div><span>${fmtTime(secs[i])}</span></div>`).join('');
  };
  $('s-zp').innerHTML = zoneRows(POWER_ZONES, sum.zonePow);
  $('s-zh').innerHTML = sum.avgHr ? zoneRows(HR_ZONES, sum.zoneHr) : '<small>No heart-rate data</small>';

  $('s-ach').innerHTML = sum.unlocked.map((id) => {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    return `<span class="badge">🏅 ${a.name}</span>`;
  }).join('') + sum.discovered.map((id) => {
    const lm = LANDMARKS.find((x) => x.id === id);
    return `<span class="badge">${lm.emoji} ${lm.name}</span>`;
  }).join('');

  const xp = xpBefore + sum.score;
  const lvl = levelFor(xp);
  $('s-level').textContent = `Level ${lvl}${lvl > levelBefore ? ' ⬆' : ''}`;
  $('s-lvltitle').textContent = levelTitle(lvl);
  $('s-xpbar').style.width = `${((xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl))) * 100}%`;
  $('s-xp').textContent = `+${sum.score.toLocaleString()} XP · ${xp.toLocaleString()} total`;
}
