// Drawing for the map, the climb profile and the elevation strip. Pure canvas, no DOM lookups, so it is
// easy to test and restyle. The look is deliberately sober: dark slate, thin lines, vector glyphs.

import { LOOP, TOTAL, SPURS, spurAt, MAP, SPUR_MAP, LANDMARKS, BIOMES, SEGMENTS, LAKE_SHAPE, elevation, gradeAt, posAt, headingAt } from './course.js';

// ---- shared palette -------------------------------------------------------------------------------------------

export const INK = '#0b111b';
export const LINE = '#7f93ad';

/** Colour for a road grade (rise/run): cool for descents, warm to red as it gets steeper. */
export function gradeColor(g) {
  if (g < -0.02) return '#5b8fd6';
  if (g < 0.015) return '#8fb7a0';
  if (g < 0.04) return '#d6c35c';
  if (g < 0.06) return '#f0a23a';
  if (g < 0.08) return '#ec6a3c';
  return '#d93a4a';
}

// ---- glyphs -------------------------------------------------------------------------------------------------------

/** A small round badge with a vector symbol for a landmark; hollow with "?" until discovered. */
export function glyph(ctx, kind, x, y, r, found) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(r / 8, r / 8);
  ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7);
  ctx.fillStyle = found ? 'rgba(14,21,34,0.92)' : 'rgba(14,21,34,0.7)';
  ctx.fill();
  ctx.lineWidth = 1.3; ctx.strokeStyle = found ? '#c9d5e6' : 'rgba(127,147,173,0.55)';
  ctx.stroke();
  ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#f2f6fc'; ctx.fillStyle = '#f2f6fc';
  if (!found) {
    ctx.fillStyle = 'rgba(160,176,198,0.8)';
    ctx.font = '700 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', 0, 0.5);
    ctx.restore();
    return;
  }
  ctx.beginPath();
  switch (kind) {
    case 'arch': ctx.moveTo(-2.4, -4.5); ctx.lineTo(-2.4, 4.5); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-2.4, -4.5); ctx.lineTo(4.2, -2.4); ctx.lineTo(-2.4, -0.2); ctx.fill(); break;
    case 'windmill': ctx.moveTo(-4, -4); ctx.lineTo(4, 4); ctx.moveTo(4, -4); ctx.lineTo(-4, 4); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, 7); ctx.fill(); break;
    case 'cows': ctx.arc(-2.1, 0.4, 2.2, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(2.6, 1.2, 1.7, 0, 7); ctx.fill(); break;
    case 'cabin': ctx.moveTo(-4, 3); ctx.lineTo(-4, -0.5); ctx.lineTo(0, -4); ctx.lineTo(4, -0.5); ctx.lineTo(4, 3); ctx.closePath(); ctx.stroke(); break;
    case 'tunnel': ctx.moveTo(-4, 4); ctx.lineTo(-4, 0); ctx.arc(0, 0, 4, Math.PI, 0); ctx.lineTo(4, 4); ctx.stroke(); break;
    case 'summit': ctx.moveTo(-5, 4); ctx.lineTo(0, -4.6); ctx.lineTo(5, 4); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-1.6, -1.2); ctx.lineTo(0, -4.6); ctx.lineTo(1.6, -1.2); ctx.closePath(); ctx.fill(); break;
    case 'castle': ctx.moveTo(-4, 4); ctx.lineTo(-4, -3); ctx.lineTo(-2, -3); ctx.lineTo(-2, -1.4); ctx.lineTo(2, -1.4); ctx.lineTo(2, -3); ctx.lineTo(4, -3); ctx.lineTo(4, 4); ctx.closePath(); ctx.stroke(); break;
    case 'bridge': ctx.moveTo(-5, 1.5); ctx.lineTo(5, 1.5); ctx.moveTo(-5, 1.5); ctx.quadraticCurveTo(0, -5, 5, 1.5); ctx.stroke(); break;
    case 'lighthouse': ctx.moveTo(-2.2, 4.5); ctx.lineTo(-1.2, -2.6); ctx.lineTo(1.2, -2.6); ctx.lineTo(2.2, 4.5); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-3.8, -4.4); ctx.lineTo(-1.6, -3.4); ctx.moveTo(3.8, -4.4); ctx.lineTo(1.6, -3.4); ctx.stroke(); break;
    case 'market': ctx.moveTo(-5, 3.2); ctx.lineTo(0, -3.8); ctx.lineTo(5, 3.2); ctx.closePath(); ctx.stroke(); break;
    case 'church': ctx.moveTo(0, -5); ctx.lineTo(0, 4.5); ctx.moveTo(-3, -1.8); ctx.lineTo(3, -1.8); ctx.stroke(); break;
    default: ctx.arc(0, 0, 2, 0, 7); ctx.fill();
  }
  ctx.restore();
}

// ---- route helpers -----------------------------------------------------------------------------------------------------

function traceRoute(ctx, P, from, to) {
  ctx.beginPath();
  let first = true;
  for (const p of from >= LOOP ? SPUR_MAP.pts : MAP.pts) {
    if (p.d < from - 12.5 || p.d > to + 12.5) continue;
    const [x, y] = P(p.x, p.y);
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
}

const roundRectPath = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };

// ---- the map -----------------------------------------------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} game
 * @param {{zoom:boolean, selectedId:string|null}} opts
 */
export function drawMap(canvas, game, { zoom = false, selectedId = null } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 46;
  const B = SPUR_MAP; // the whole course, loop and road around
  const fit = Math.min((w - pad * 2) / (B.maxX - B.minX), (h - pad * 2) / (B.maxY - B.minY));
  const me = posAt(game.user.c);
  const s = zoom ? fit * 3.4 : fit;
  const cx = zoom ? me.x : (B.minX + B.maxX) / 2;
  const cy = zoom ? me.y : (B.minY + B.maxY) / 2;
  const P = (x, y) => [w / 2 + (x - cx) * s, h / 2 - (y - cy) * s];
  const k = s / fit; // line-weight scale when zoomed
  const wt = (v) => v * Math.min(1.7, 0.55 + k * 0.45);

  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, 16); ctx.clip();
  ctx.fillStyle = INK; ctx.fillRect(0, 0, w, h);

  // faint survey grid, one line every 500 m
  ctx.strokeStyle = 'rgba(127,147,173,0.09)'; ctx.lineWidth = 1;
  const g0x = Math.floor((cx - w / 2 / s) / 500) * 500, g1x = cx + w / 2 / s;
  const g0y = Math.floor((cy - h / 2 / s) / 500) * 500, g1y = cy + h / 2 / s;
  ctx.beginPath();
  for (let gx = g0x; gx <= g1x; gx += 500) { const [x] = P(gx, 0); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let gy = g0y; gy <= g1y; gy += 500) { const [, y] = P(0, gy); ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  // land tint by zone, as soft bands under the route
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const b of BIOMES) {
    traceRoute(ctx, P, b.start, b.end);
    ctx.strokeStyle = `rgba(${b.ground.map(Math.round).join(',')},0.2)`;
    ctx.lineWidth = wt(46);
    ctx.stroke();
  }

  // the lake
  const lp = posAt(LAKE_SHAPE.d), th = headingAt(LAKE_SHAPE.d);
  const lc = P(lp.x - Math.sin(th) * LAKE_SHAPE.offset, lp.y + Math.cos(th) * LAKE_SHAPE.offset);
  ctx.beginPath(); ctx.ellipse(lc[0], lc[1], LAKE_SHAPE.ra * s, LAKE_SHAPE.rb * s, -th, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(62,112,164,0.34)'; ctx.fill();
  ctx.strokeStyle = 'rgba(130,175,225,0.45)'; ctx.lineWidth = 1.2; ctx.stroke();

  // timed segments as underlays
  for (const sg of SEGMENTS) {
    traceRoute(ctx, P, sg.start, sg.end);
    ctx.strokeStyle = sg.color; ctx.globalAlpha = 0.5; ctx.lineWidth = wt(12); ctx.stroke(); ctx.globalAlpha = 1;
  }
  // the detours: dashed routes off each fork and back onto the loop (brighter once you are on one or have chosen it)
  const ext = game.extension();
  for (const sp of SPURS) {
    const lit = (ext.state === 'on' || ext.armed) && ext.spur === sp;
    traceRoute(ctx, P, sp.base, sp.end);
    ctx.strokeStyle = '#03060b'; ctx.lineWidth = wt(8.5); ctx.stroke();
    traceRoute(ctx, P, sp.base, sp.end);
    ctx.strokeStyle = lit ? sp.color : `${sp.color}a0`; ctx.lineWidth = wt(4.2);
    ctx.setLineDash([wt(9), wt(6)]); ctx.stroke(); ctx.setLineDash([]);
  }
  // route: casing then grade-coloured line
  traceRoute(ctx, P, 0, LOOP);
  ctx.strokeStyle = '#03060b'; ctx.lineWidth = wt(8.5); ctx.stroke();
  for (let i = 1; i < MAP.pts.length; i++) {
    const a = MAP.pts[i - 1], b = MAP.pts[i];
    const [x0, y0] = P(a.x, a.y), [x1, y1] = P(b.x, b.y);
    ctx.strokeStyle = gradeColor(gradeAt(b.d % LOOP));
    ctx.lineWidth = wt(4.2);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }

  // direction chevrons and kilometre ticks
  ctx.lineWidth = 1.4;
  for (let d = 250; d < LOOP; d += 500) {
    const a = posAt(d), b = posAt(d + 12);
    const [x, y] = P(a.x, a.y), [x2, y2] = P(b.x, b.y);
    const ang = Math.atan2(y2 - y, x2 - x);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.moveTo(-2.4, -3); ctx.lineTo(1.6, 0); ctx.lineTo(-2.4, 3); ctx.stroke();
    ctx.restore();
  }
  for (const sp of SPURS) {
    for (let d = sp.base + 500; d < sp.end; d += 1000) {
      const a = posAt(d), b = posAt(d + 12);
      const [x, y] = P(a.x, a.y), [x2, y2] = P(b.x, b.y);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(y2 - y, x2 - x));
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.moveTo(-2.4, -3); ctx.lineTo(1.6, 0); ctx.lineTo(-2.4, 3); ctx.stroke();
      ctx.restore();
    }
  }
  // the forks
  for (const sp of SPURS) {
    const a = posAt(sp.fork), [x, y] = P(a.x, a.y);
    const mine = ext.spur === sp;
    const armed = ext.armed && mine && ext.state === 'approach';
    const pulse = mine && ext.state === 'approach' ? 0.5 + 0.5 * Math.sin(game.clock * 5) : 0;
    ctx.beginPath(); ctx.arc(x, y, (zoom ? 8 : 6.5) + pulse * 3, 0, 7);
    ctx.fillStyle = armed ? sp.color : 'rgba(14,21,34,0.92)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = sp.color; ctx.stroke();
    ctx.fillStyle = armed ? '#05080d' : sp.color; ctx.font = '800 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('+', x, y + 0.5);
    if (zoom || (mine && ext.state === 'approach')) {
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = '700 10px system-ui, sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3; ctx.strokeText(`Fork: ${sp.name}`, x + 12, y - 9); ctx.fillText(`Fork: ${sp.name}`, x + 12, y - 9);
    }
  }
  ctx.font = '600 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let km = 1; km < 10; km++) {
    const a = posAt(km * 1000), b = posAt(km * 1000 + 12);
    const [x, y] = P(a.x, a.y), [x2, y2] = P(b.x, b.y);
    const nx = -(y2 - y), ny = x2 - x, nl = Math.hypot(nx, ny) || 1;
    const lx = x + (nx / nl) * 12, ly = y + (ny / nl) * 12;
    ctx.strokeStyle = 'rgba(210,220,235,0.7)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x - (nx / nl) * 4, y - (ny / nl) * 4); ctx.lineTo(x + (nx / nl) * 5, y + (ny / nl) * 5); ctx.stroke();
    ctx.fillStyle = 'rgba(200,212,230,0.85)'; ctx.fillText(String(km), lx, ly);
  }

  // landmarks
  const found = game.progress.discovered;
  for (const lm of LANDMARKS) {
    const q = posAt(lm.d), q2 = posAt(lm.d + 10);
    const [x, y] = P(q.x, q.y), [x2, y2] = P(q2.x, q2.y);
    const dx = x2 - x, dy = y2 - y, dl = Math.hypot(dx, dy) || 1;
    const side = Math.sign(lm.lat) || 1; // + = right of travel
    const ox = (dy / dl) * 17 * side, oy = (-dx / dl) * 17 * side;
    if (lm.kind === 'arch') { glyph(ctx, lm.kind, x, y, zoom ? 8 : 7, !!found[lm.id]); continue; }
    ctx.strokeStyle = 'rgba(160,176,198,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ox, y + oy); ctx.stroke();
    glyph(ctx, lm.kind, x + ox, y + oy, zoom ? 8.5 : 7, !!found[lm.id]);
    if (zoom && found[lm.id]) {
      ctx.fillStyle = 'rgba(220,230,244,0.85)'; ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(lm.name, x + ox + 12, y + oy);
    }
  }

  // riders: the others as dots, selected one labelled, you as a heading arrow
  for (const { r } of game.board().slice().reverse()) {
    if (r.isUser) continue;
    const q = posAt(r.c);
    const [x, y] = P(q.x, q.y);
    const sel = r.id === selectedId;
    ctx.beginPath(); ctx.arc(x, y, sel ? 5.6 : 4, 0, 7);
    ctx.fillStyle = r.kind === 'coach' ? '#ffd400' : r.color; ctx.fill();
    ctx.lineWidth = sel ? 2 : 1.3; ctx.strokeStyle = r.kind === 'remote' ? '#7fe3ff' : sel ? '#ffffff' : '#05080d'; ctx.stroke();
    if (sel) {
      ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3; ctx.strokeText(r.name, x + 9, y - 8); ctx.fillText(r.name, x + 9, y - 8);
    }
  }
  const [ux, uy] = P(me.x, me.y);
  const head = headingAt(game.user.c);
  const pulse = (game.clock * 0.9) % 1;
  ctx.beginPath(); ctx.arc(ux, uy, 8 + pulse * 14, 0, 7);
  ctx.strokeStyle = `rgba(120,190,255,${0.5 * (1 - pulse)})`; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.save(); ctx.translate(ux, uy); ctx.rotate(-head);
  ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6.5, 6.5); ctx.lineTo(-3, 0); ctx.lineTo(-6.5, -6.5); ctx.closePath();
  ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#ff3b6b'; ctx.stroke();
  ctx.restore();

  // north arrow and scale bar
  ctx.save(); ctx.translate(20, 22);
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, 7); ctx.fillStyle = 'rgba(14,21,34,0.8)'; ctx.fill(); ctx.strokeStyle = 'rgba(127,147,173,0.5)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(3.5, 3); ctx.lineTo(0, 1); ctx.lineTo(-3.5, 3); ctx.closePath(); ctx.fillStyle = '#e8eef7'; ctx.fill();
  ctx.restore();
  const meters = zoom ? 200 : 500;
  const bar = meters * s;
  ctx.strokeStyle = 'rgba(220,230,244,0.85)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(14, h - 16); ctx.lineTo(14 + bar, h - 16); ctx.moveTo(14, h - 20); ctx.lineTo(14, h - 12); ctx.moveTo(14 + bar, h - 20); ctx.lineTo(14 + bar, h - 12); ctx.stroke();
  ctx.fillStyle = 'rgba(220,230,244,0.85)'; ctx.font = '600 9px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${meters} m`, 14 + bar + 6, h - 13);
  ctx.restore();
}

// ---- climb profile --------------------------------------------------------------------------------------------------------

/** Elevation profile of a climb coloured by grade; what's done is dimmed, you are the marker. */
export function drawClimbProfile(canvas, climb, stats) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const padL = 6, padR = 6, padT = 22, padB = 18;
  const len = climb.end - climb.start;
  const a0 = elevation(climb.start), a1 = elevation(climb.end);
  const lo = a0 - 6, hi = a1 + 10;
  const X = (m) => padL + (m / len) * (w - padL - padR);
  const Y = (alt) => padT + (1 - (alt - lo) / (hi - lo)) * (h - padT - padB);
  const step = 20;
  const here = stats.into;
  for (let m = 0; m < len; m += step) {
    const d0 = climb.start + m, d1 = Math.min(climb.end, d0 + step);
    const g = (elevation(d1) - elevation(d0)) / (d1 - d0);
    const x0 = X(m), x1 = X(m + step) + 0.6;
    const done = m + step <= here;
    ctx.globalAlpha = done ? 0.32 : 0.95;
    ctx.fillStyle = gradeColor(g);
    ctx.beginPath();
    ctx.moveTo(x0, h - padB); ctx.lineTo(x0, Y(elevation(d0))); ctx.lineTo(x1, Y(elevation(d1))); ctx.lineTo(x1, h - padB);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // baseline, km ticks
  ctx.strokeStyle = 'rgba(160,176,198,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, h - padB + 0.5); ctx.lineTo(w - padR, h - padB + 0.5); ctx.stroke();
  ctx.fillStyle = 'rgba(160,176,198,0.75)'; ctx.font = '600 9px system-ui, sans-serif'; ctx.textAlign = 'center';
  for (let m = 0; m <= len; m += 500) {
    ctx.beginPath(); ctx.moveTo(X(m), h - padB); ctx.lineTo(X(m), h - padB + 3); ctx.stroke();
    if (m % 1000 === 0) ctx.fillText(`${m / 1000}`, X(m), h - 4);
  }
  ctx.textAlign = 'right'; ctx.fillText('km', w - padR, h - 4);
  // summit flag
  ctx.textAlign = 'right'; ctx.fillStyle = '#e8eef7'; ctx.font = '700 10px system-ui, sans-serif';
  ctx.fillText(`${Math.round(a1)} m`, w - padR, 12);
  // you
  const mx = X(Math.min(len, Math.max(0, here)));
  const my = Y(stats.altNow);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(mx, padT - 4); ctx.lineTo(mx, h - padB); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(mx, my, 5, 0, 7); ctx.fillStyle = '#ff3b6b'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
  const label = `${(stats.gradeNow * 100).toFixed(1)}%`;
  ctx.font = '700 10px system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 10;
  const bx = Math.min(w - tw - 2, Math.max(2, mx - tw / 2));
  ctx.fillStyle = 'rgba(11,17,27,0.9)'; roundRectPath(ctx, bx, 2, tw, 15, 7); ctx.fill();
  ctx.fillStyle = gradeColor(stats.gradeNow); ctx.textAlign = 'center'; ctx.fillText(label, bx + tw / 2, 13);
}

// ---- elevation strip -----------------------------------------------------------------------------------------------------------

export function drawStrip(canvas, game) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pad = 16;
  const spur = game.user.spur; // the strip shows the stretch you are on: the loop, or the detour you are riding
  const sp = spur ? SPURS[spurAt(game.user.c)] : null;
  const base = sp ? sp.base : 0, len = sp ? sp.len : LOOP;
  const X = (c) => pad + ((c - base) / len) * (w - pad * 2);
  drawStrip.cache ||= {};
  const cacheKey = sp ? sp.id : 'loop';
  if (!drawStrip.cache[cacheKey]) {
    const pts = [];
    for (let d = 0; d <= len; d += 40) pts.push([base + Math.min(d, len - 1e-6), elevation(base + Math.min(d, len - 1e-6))]);
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    drawStrip.cache[cacheKey] = { pts, min: spur ? lo - 6 : lo, max: spur ? Math.max(hi, lo + 24) : hi }; // keep a flat road looking flat
  }
  const { pts, min, max } = drawStrip.cache[cacheKey];
  const top = 30, bottom = h - 14;
  const Y = (el) => bottom - ((el - min) / (max - min)) * (bottom - top);
  // zone colours along the base
  for (const b of BIOMES) {
    if (b.start < LOOP ? spur : spurAt(b.start) !== sp?.index) continue;
    ctx.fillStyle = `rgba(${b.ground.map(Math.round).join(',')},0.8)`; ctx.fillRect(X(b.start), bottom + 3, X(b.end) - X(b.start), 4);
  }
  // profile area and a grade-coloured ridge line
  ctx.beginPath(); ctx.moveTo(pad, bottom + 1);
  for (const [d, el] of pts) ctx.lineTo(X(d), Y(el));
  ctx.lineTo(w - pad, bottom + 1);
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, 'rgba(160,180,205,0.28)'); g.addColorStop(1, 'rgba(160,180,205,0.05)');
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    ctx.strokeStyle = gradeColor(gradeAt((pts[i][0] + pts[i - 1][0]) / 2));
    ctx.beginPath(); ctx.moveTo(X(pts[i - 1][0]), Y(pts[i - 1][1])); ctx.lineTo(X(pts[i][0]), Y(pts[i][1])); ctx.stroke();
  }
  // km ticks
  ctx.fillStyle = 'rgba(160,176,198,0.7)'; ctx.font = '600 9px system-ui, sans-serif'; ctx.textAlign = 'center';
  for (let km = 0; km * 1000 <= len; km += len > 12000 ? 4 : 2) ctx.fillText(String(km), X(base + km * 1000), h - 1);
  // the forks, on the loop's strip
  if (!spur) {
    const next = game.extension().spur;
    for (const f of SPURS) {
      const x = X(f.fork), armed = game.spurIntent && next === f;
      ctx.strokeStyle = armed ? f.color : `${f.color}b0`; ctx.lineWidth = 1.5; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, bottom + 2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = armed ? f.color : `${f.color}e0`; ctx.font = '800 9px system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`${f.stripLabel} ↱`, x - 4, top - 6);
    }
  }
  // landmarks
  const found = game.progress.discovered;
  for (const lm of LANDMARKS) {
    if (spurAt(lm.d) !== (sp ? sp.index : -1)) continue;
    glyph(ctx, lm.kind, X(lm.d), Math.max(11, Y(elevation(lm.d)) - 10), 6, !!found[lm.id]);
  }
  // riders and you
  for (const { r } of game.board().slice().reverse()) {
    if (r.isUser || r.spur !== spur || (spur && spurAt(r.c) !== sp.index)) continue;
    ctx.beginPath(); ctx.arc(X(r.c), Y(elevation(r.c)), 3, 0, 7);
    ctx.fillStyle = r.kind === 'coach' ? '#ffd400' : r.color; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#05080d'; ctx.stroke();
  }
  const ux = X(game.user.c), uy = Y(elevation(game.user.c));
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(ux, top - 2); ctx.lineTo(ux, bottom); ctx.stroke();
  ctx.beginPath(); ctx.arc(ux, uy, 5, 0, 7); ctx.fillStyle = '#ff3b6b'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
}
