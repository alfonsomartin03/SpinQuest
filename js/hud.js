// DOM heads-up display, workout/power graph, mini-map, toasts and the summary screen.

import {
  POWER_ZONES, HR_ZONES, LOOP, elevation, powerZone, levelFor, levelTitle, xpForLevel, fmtTime, clamp,
} from './physics.js';
import { LANDMARKS, BIOMES, CLIMBS, SPURS, LOOP as LOOP_LEN, activeClimb, climbSplits, biomeIndex, spurAt } from './course.js';
import { drawMap, drawClimbProfile, drawStrip, gradeColor as gradeColorImport } from './hudviz.js';
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
      'h-level', 'h-xpbar', 'h-step', 'h-next', 'h-target', 'h-twatts', 'h-remain', 'h-graph', 'h-wait', 'h-sim', 'h-map', 'h-mapnote', 'h-zone', 'h-mapbox', 'h-board-count', 'h-rcard', 'h-climb', 'c-name', 'c-sub', 'c-left', 'c-elev', 'c-avg',
      'c-now', 'c-next', 'c-vam', 'c-eta', 'c-top', 'c-steep', 'c-profile', 'h-turn', 'h-turn-title', 'h-turn-sub', 'h-turn-btn', 'h-turn-hint', 'h-turn-bar']) this.el[id] = $(id);
    this.selectedId = null;
    this.vamBuf = [];
    this.paceBuf = []; // {t, x}: where you were over the last 30 s of riding, for the time left to the top
    this.spd = 0;
    this.maxRows = 8;
    this.layoutAt = -9;
    this.vizAt = 0;
    this.el['h-board'].addEventListener('click', (ev) => {
      const row = ev.target.closest('.rrow');
      if (!row) return;
      this.selectedId = this.selectedId === row.dataset.id ? null : row.dataset.id;
      this.boardAt = -1;
    });
    addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { this.selectedId = null; this.boardAt = -1; } });
    this.mapZoom = false;
    $('h-mapbox').addEventListener('click', () => { this.mapZoom = !this.mapZoom; $('h-mapbox').classList.toggle('zoomed', this.mapZoom); });
    this.el['h-zonebar'].innerHTML = POWER_ZONES.map(() => '<i></i>').join('');
    this.zoneBars = [...this.el['h-zonebar'].children];
    POWER_ZONES.forEach((z, i) => { this.zoneBars[i].style.background = z.color; });
    this.el['h-turn-btn'].addEventListener('click', () => this.game?.toggleExtension());
    this.lastBeat = -1;
    this.lastMult = 1;
    this.graphAt = 0;
    this.boardAt = 0;
  }

  update(game, simActive) {
    const e = this.el;
    this.game = game;
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
    setText(e['h-wait'], game.started ? 'Paused. Pedal to carry on.' : 'Start pedalling to begin');
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
    this.#turn(game);
    this.#climb(game);
    if (game.clock - this.vizAt > 0.066) { // the map and strip don't need 60 fps
      this.vizAt = game.clock;
      drawStrip(this.el['h-mini'], game);
      drawMap(this.el['h-map'], game, { zoom: this.mapZoom, selectedId: this.selectedId });
      setText(this.el['h-mapnote'], this.mapZoom ? 'following you' : `${Object.keys(game.progress.discovered).length} of ${LANDMARKS.length} landmarks found`);
    }
    this.#zone(game);
    if (game.clock - this.graphAt > 0.5) {
      this.graphAt = game.clock;
      if (game.workout.steps.length && !game.workout.erg) drawWorkoutProfile(e['h-graph'], game.workout, ftp, { playhead: game.wt, samples: game.samples });
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
      setText(e['h-next'], 'Your power, last 5 minutes');
      setText(e['h-remain'], '');
      tg.hidden = true;
      return;
    }
    if (game.workout.erg) { // ERG mode: one steady target, adjustable while riding
      tg.hidden = !game.target;
      setText(e['h-step'], 'ERG mode');
      setText(e['h-next'], 'Match the target. + and − change it by 10 watts.');
      setText(e['h-remain'], '');
      if (game.target) {
        setText(e['h-twatts'], String(game.target.watts));
        const d = game.p3 - game.target.watts;
        tg.classList.toggle('on', Math.abs(d) <= game.target.tol);
        tg.classList.toggle('low', d < -game.target.tol);
        tg.classList.toggle('high', d > game.target.tol);
      }
      return;
    }
    if (!w) {
      setText(e['h-step'], game.workout.name);
      setText(e['h-next'], 'Start pedalling to begin');
      return;
    }
    tg.hidden = !game.target;
    setText(e['h-step'], game.finished ? 'Workout complete' : (w.step.label || 'Interval'));
    setText(e['h-next'], w.next ? `Next: ${w.next.label || 'Interval'}, ${Math.round(w.next.from * game.profile.ftp)} watts for ${fmtTime(w.next.dur)}` : 'Last interval');
    setText(e['h-remain'], fmtTime(w.remaining));
    if (game.target) {
      setText(e['h-twatts'], String(game.target.watts));
      const d = game.p3 - game.target.watts;
      tg.classList.toggle('on', Math.abs(d) <= game.target.tol);
      tg.classList.toggle('low', d < -game.target.tol);
      tg.classList.toggle('high', d > game.target.tol);
    }
  }

  /** How many sidebar rows fit above the bottom panels. */
  #fitRows(clock) {
    if (clock - this.layoutAt < 1) return;
    this.layoutAt = clock;
    const bottom = document.querySelector('#hud .bottom');
    if (!bottom) return;
    const box = this.el['h-mapbox'];
    if (box.offsetHeight) this.mapH = box.offsetHeight; // keep the last height while the rider card is standing in for the map
    const mapH = this.mapH || 0;
    const avail = bottom.getBoundingClientRect().top - 14 - 10 - mapH - 60 - 10;
    this.maxRows = clamp(Math.floor(avail / 30), 3, 10);
  }

  #board(game) {
    this.#fitRows(game.clock);
    const all = game.board();
    const n = Math.min(all.length, this.maxRows);
    const ui = all.findIndex((e) => e.r.isUser);
    const start = clamp(ui - Math.floor(n / 2), 0, all.length - n);
    const user = game.user;
    const mark = { coach: '<em class="kind k-coach" title="Coach">★</em>', remote: '<em class="kind k-remote" title="Live rider">●</em>' };
    const rows = all.slice(start, start + n).map(({ r, gapSec, gap }, i) => {
      const watts = Math.round(r.p3);
      const wkg = r.weight ? (r.p3 / r.weight).toFixed(1) : '--';
      const speed = (r.v * 3.6).toFixed(r.isUser ? 1 : 0);
      const gapTxt = r.isUser ? '' : fmtGap(gapSec);
      const col = r.kind === 'coach' ? '#ffd400' : r.color;
      return `<div class="rrow ${r.isUser ? 'me' : ''} ${r.id === this.selectedId ? 'sel' : ''} ${r.drafting ? 'draft' : ''}" data-id="${r.id}" title="${r.isUser ? 'You' : `${Math.abs(Math.round(gap))} m ${gap > 0 ? 'ahead' : 'behind'}`}">
        <i class="rpos">${start + i + 1}</i><i class="rcol" style="background:${col}"></i>
        <span class="rname">${mark[r.kind] ?? ''}${esc(r.name)}</span>
        <span class="rpow"><b>${watts}</b><small>${wkg}</small></span>
        <span class="rspd">${speed}</span>
        <span class="rgap ${gapSec > 0 ? 'ahead' : 'behind'}">${gapTxt}</span></div>`;
    }).join('');
    this.el['h-board'].innerHTML = `<div class="rhead"><span></span><span></span><span>Rider</span><span>W · W/kg</span><span>km/h</span><span>Gap</span></div>${rows}`;
    setText(this.el['h-board-count'], `${all.length} riding`);
    void user;
    this.#card(game, all);
  }

  /** Details for the rider picked in the list (click a row; Esc clears). */
  #card(game, all) {
    const card = this.el['h-rcard'];
    const e = all.find((x) => x.r.id === this.selectedId);
    if (!e) { card.hidden = true; return; }
    const { r, gap, gapSec } = e;
    const wkg = r.p3 / r.weight;
    const ftpWkg = r.ftp / r.weight;
    const zone = POWER_ZONES[powerZone(r.p3, r.ftp)];
    const dist = Math.max(0, r.x - (game.user.x - game.distance)) / 1000;
    card.hidden = false;
    card.innerHTML = `
      <div class="rc-head"><i style="background:${r.kind === 'coach' ? '#ffd400' : r.color}"></i><b>${esc(r.name)}</b><button class="rc-x" aria-label="Close">×</button></div>
      <div class="rc-big"><span style="color:${zone.color}">${Math.round(r.p3)}<small>W</small></span><span>${wkg.toFixed(1)}<small>W/kg</small></span></div>
      <div class="rc-grid">
        <div><small>Speed</small><b>${(r.v * 3.6).toFixed(1)} km/h</b></div>
        <div><small>Cadence</small><b>${r.cad ? Math.round(r.cad) : '--'} rpm</b></div>
        <div><small>Heart rate</small><b>${r.hr != null ? Math.round(r.hr) : '--'} bpm</b></div>
        <div><small>${r.isUser ? 'Your FTP' : 'FTP'}</small><b>${Math.round(r.ftp)} W · ${ftpWkg.toFixed(1)}</b></div>
        <div><small>Weight</small><b>${Math.round(r.weight)} kg</b></div>
        <div><small>${r.isUser ? 'Ridden' : gap >= 0 ? 'Ahead by' : 'Behind by'}</small><b>${r.isUser ? dist.toFixed(2) + ' km' : `${fmtGap(gapSec).slice(1)} · ${Math.abs(Math.round(gap))} m`}</b></div>
      </div>
      <div class="rc-foot">${r.kind === 'bot' ? 'Simulated rider' : r.kind === 'remote' ? 'Live rider' : r.kind === 'coach' ? 'Your workout coach' : ''}${r.drafting ? ' · drafting' : ''}</div>`;
    card.querySelector('.rc-x').onclick = () => { this.selectedId = null; this.boardAt = -1; };
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
    const u = game.user;
    const phase = u.c;
    const bi = biomeIndex(phase);
    // the next landmark on the stretch of road you are on
    let best = null;
    for (const lm of LANDMARKS) {
      if (spurAt(lm.d) !== spurAt(phase)) continue;
      const dist = u.spur ? lm.d - phase : (lm.d - phase + LOOP_LEN) % LOOP_LEN;
      if (dist > 15 && (!best || dist < best.dist)) best = { lm, dist };
    }
    const found = best && game.progress.discovered[best.lm.id];
    const dTxt = best ? (best.dist < 1000 ? `${Math.round(best.dist / 10) * 10} m` : `${(best.dist / 1000).toFixed(1)} km`) : '';
    setText(this.el['h-zone'], `${BIOMES[bi].name} · ${Math.round(elevation(phase))} m${best ? `   ·   Next: ${found ? best.lm.name : 'unknown landmark'} in ${dTxt}` : ''}`);
  }

  /** The next fork: announced a kilometre out, with a button (or a double click of the Zwift Click) to take the detour. */
  #turn(game) {
    const e = this.el;
    const x = game.extension();
    e['h-turn'].hidden = x.state === 'far';
    if (x.state === 'far') return;
    const box = e['h-turn'];
    const sp = x.spur;
    box.classList.toggle('armed', !!x.armed);
    box.classList.toggle('on', x.state === 'on');
    box.style.setProperty('--turn', sp.color);
    if (x.state === 'on') {
      setText(e['h-turn-title'], sp.onTitle);
      setText(e['h-turn-sub'], `${(x.left / 1000).toFixed(1)} km to go. ${sp.onSub}`);
      e['h-turn-btn'].hidden = true;
      e['h-turn-hint'].hidden = true;
      e['h-turn-bar'].style.width = `${(x.done / x.length) * 100}%`;
      return;
    }
    const m = Math.max(0, Math.round(x.toTurn / 10) * 10);
    setText(e['h-turn-title'], x.armed ? `${sp.armedTitle} · fork in ${m} m` : `Fork in ${m} m`);
    setText(e['h-turn-sub'], x.armed ? sp.armedSub : `${sp.question} ${sp.ask(sp)}`);
    setText(e['h-turn-btn'], x.armed ? sp.cancel : sp.button);
    e['h-turn-btn'].hidden = false;
    e['h-turn-hint'].hidden = false;
    e['h-turn-bar'].style.width = `${(1 - x.toTurn / 1000) * 100}%`;
  }

  /** Distance left, elevation left and gradient information while on (or about to start) a climb. */
  #climb(game) {
    const e = this.el;
    let act = activeClimb(game.user.c);
    if (act && game.spurIntent && act.climb.start < LOOP_LEN) act = null; // no climb panel once you have chosen to skip it
    e['h-climb'].hidden = !act;
    if (!act) { this.vamBuf.length = 0; this.paceBuf.length = 0; return; }
    const { climb, stats: st } = act;
    // pace over the last 30 s of riding (so a pause or a sprint 5 minutes ago doesn't skew it), and a 60 s climbing-rate (VAM) window
    const pb = this.paceBuf;
    if (!pb.length || game.t - pb[pb.length - 1].t >= 0.5) {
      pb.push({ t: game.t, x: game.user.x });
      while (pb.length > 2 && game.t - pb[1].t >= 30) pb.shift();
    }
    const oldest = pb[0], newest = pb[pb.length - 1];
    this.spd = newest.t - oldest.t >= 5 ? (newest.x - oldest.x) / (newest.t - oldest.t) : game.user.v; // until there are 5 s of history, now
    const buf = this.vamBuf;
    if (st.state === 'on' && (!buf.length || game.clock - buf[buf.length - 1].t > 0.5)) {
      buf.push({ t: game.clock, alt: st.altNow });
      while (buf.length && game.clock - buf[0].t > 60) buf.shift();
    }
    let vam = 0;
    if (buf.length > 10) { const o = buf[0], n = buf[buf.length - 1]; vam = Math.max(0, ((n.alt - o.alt) / (n.t - o.t)) * 3600); }
    const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
    const pct = (g) => `${(g * 100).toFixed(1)}%`;
    setText(e['c-name'], climb.name);
    setText(e['c-sub'], st.state === 'before'
      ? `Starts in ${km(st.toStart)} · ${(st.len / 1000).toFixed(1)} km, ${pct(st.avgAll)} average`
      : `${Math.round(st.progress * 100)}% done · ${(st.len / 1000).toFixed(1)} km, ${pct(st.avgAll)} average`);
    setText(e['c-left'], km(st.left));
    setText(e['c-elev'], `${Math.round(st.elevLeft)} m`);
    setText(e['c-avg'], pct(st.avgLeft));
    setText(e['c-now'], pct(st.gradeNow));
    e['c-now'].style.color = gradeColorFor(st.gradeNow);
    setText(e['c-next'], pct(st.next500));
    e['c-next'].style.color = gradeColorFor(st.next500);
    setText(e['c-vam'], vam ? `${Math.round(vam).toLocaleString()} m/h` : '--');
    setText(e['c-eta'], this.spd > 0.8 && st.state === 'on' ? fmtTime(st.left / this.spd) : '--');
    setText(e['c-top'], `${Math.round(st.summitAlt).toLocaleString()} m`);
    setText(e['c-steep'], st.left > 30 ? `Steepest part: ${pct(st.steepest.grade)}, in ${km(st.steepest.dist)}` : 'Almost there!');
    drawClimbProfile(e['c-profile'], climb, st);
  }
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gradeColorFor = (g) => gradeColorImport(g);
function fmtGap(sec) {
  const a = Math.abs(sec);
  if (a >= 600) return `${sec > 0 ? '+' : '−'}10:00+`;
  return `${sec > 0 ? '+' : '−'}${Math.floor(a / 60)}:${String(Math.floor(a % 60)).padStart(2, '0')}`;
}

// ---- Toasts -------------------------------------------------------------------

/** Pop-up messages. Never more than two at once, and a repeat of one already showing is ignored, so the screen stays calm. */
export function toast({ text, sub, kind }) {
  const host = $('toasts');
  for (const t of host.children) if (t.dataset.key === `${text}|${sub}`) return;
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.dataset.key = `${text}|${sub}`;
  el.innerHTML = `<b></b><span></span>`;
  el.firstChild.textContent = text;
  el.lastChild.textContent = sub || '';
  host.appendChild(el);
  while (host.children.length > 2) host.firstChild.remove();
  setTimeout(() => el.remove(), 3800);
}

// ---- Summary ------------------------------------------------------------------

export function showSummary(game, levelBefore, xpBefore) {
  const sum = game.summary();
  const stat = (v, label) => `<div><b>${v}</b><small>${label}</small></div>`;
  $('s-title').textContent = sum.completed ? 'Workout complete! 🎉' : 'Nice ride!';
  $('s-stats').innerHTML = [
    stat(fmtTime(sum.time), 'Time'),
    stat((sum.distance / 1000).toFixed(1) + ' km', 'Distance'),
    stat(Math.round(sum.avgPower) + ' W', 'Avg power'),
    stat(Math.round(sum.maxP5) + ' W', 'Best 5 seconds'),
    stat(sum.avgHr ? Math.round(sum.avgHr) + ' bpm' : '--', 'Avg HR'),
    stat(sum.maxHr ? sum.maxHr + ' bpm' : '--', 'Max HR'),
    stat(Math.round(sum.kj) + ' kJ', 'Energy'),
    stat(sum.score.toLocaleString(), 'Points'),
    ...SPURS.filter((sp) => sum.detours?.[sp.id]).map((sp) => stat(`${sum.detours[sp.id]}×`, sp.name)),
  ].join('');

  const canvas = $('s-chart');
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  const s = sum.samples;
  if (s.length > 1) {
    if (sum.workout.steps.length && !sum.workout.erg) drawWorkoutProfile(canvas, sum.workout, game.profile.ftp, { samples: s });
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

  const splits = CLIMBS.map((c) => ({ c, rows: climbSplits(sum.samples, c) })).filter((x) => x.rows.length);
  $('s-splits').hidden = !splits.length;
  $('s-splits').innerHTML = splits.map(({ c, rows }) => {
    const best = Math.min(...rows.map((r) => r.time));
    return `<h4>${c.name}: splits per ascent</h4><table class="splits"><thead><tr><th>#</th><th>Time</th><th></th><th>Avg W</th><th>Avg HR</th><th>km/h</th></tr></thead><tbody>${rows.map((r) => {
      const gap = r.time - best;
      return `<tr><td>${r.lap}</td><td>${fmtTime(r.time)}</td><td>${gap < 0.5 ? '<b>best</b>' : '+' + fmtTime(gap)}</td><td>${Math.round(r.avgPower)}</td><td>${r.avgHr ? Math.round(r.avgHr) : '--'}</td><td>${(r.avgSpeed * 3.6).toFixed(1)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }).join('');

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
