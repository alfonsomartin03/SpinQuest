// Game state and rules. No DOM or canvas in here: feed it live stats, read the state back.

import {
  speedFromPower, gradeAt, elevation, START, SEGMENTS, LOOP,
  powerZone, hrZone, levelFor, clamp,
} from './physics.js';
import { LANDMARKS, BIOMES, SPURS, TOTAL, biomeIndex, spurAt } from './course.js';
import { placeOnLoop, advance, courseAt, gapBetween, roadX, sameStretch } from './route.js';
import { workoutAt, totalDuration } from './workouts.js';
import { RemoteRider, sanitizeState } from './net.js';
import { ACHIEVEMENTS } from './achievements.js';

const BOTS = [
  { lat: -3.1, name: 'Maya', color: '#ffb703', f: 0.6, off: -45 },
  { lat: 2.8, name: 'Tomás', color: '#2ec4b6', f: 0.7, off: -18 },
  { lat: -1.9, name: 'Priya', color: '#e76f51', f: 0.78, off: -6 },
  { lat: 1.9, name: 'Jonas', color: '#9b5de5', f: 0.86, off: 14 },
  { lat: 3.2, name: 'Aiko', color: '#00bbf9', f: 0.94, off: 30 },
  { lat: -2.5, name: 'Diego', color: '#f15bb5', f: 1.02, off: 55 },
];

/** Stop pedalling and the rider brakes to a halt (even downhill); after this long the ride pauses. */
export const IDLE_COAST = 1; // seconds of free-wheeling allowed
export const IDLE_PAUSE = 3; // seconds without pedalling before the ride pauses
const BRAKE = 2.4; // m/s^2

/** The fork at the foot of the climb: it is announced this far ahead, and going around can be chosen from then until you reach it. */
export const TURN_RANGE = 1000; // metres
const PACK_FOLLOW = 25; // seconds after you go around during which the bunch behind you follows

export const ORB_SPACING = 9;
const ORB_GROUP = 6;
export const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Orbs come in arcs of six, roughly every other group; one group in eight is gold. */
export function orbAt(i) {
  const group = Math.floor(i / ORB_GROUP);
  if (hash(group * 7.7) > 0.6) return null;
  const k = i - group * ORB_GROUP;
  return { i, x: i * ORB_SPACING + 4.5, lat: 0.9 * Math.sin(group * 1.9 + k * 0.45), h: 0.9 + Math.sin((k / (ORB_GROUP - 1)) * Math.PI) * 1.3, gold: hash(group * 3.3) > 0.88 };
}

let riderSeq = 1;
/**
 * Every rider (you, bots, the coach, and later remote players) has the same shape, so the sidebar, the
 * 3D scene and the network code treat them alike. kind: 'you' | 'bot' | 'coach' | 'remote'.
 */
const mkRider = (name, color, x, extra = {}) => placeOnLoop({
  id: `r${riderSeq++}`, kind: 'bot', lat: 0, name, color, x, v: 0, power: 0, p3: 0, hr: null, cad: 85, weight: 75, ftp: 200,
  crank: Math.random() * 6, wheel: 0, drag: 1, drafting: false, segStart: {}, segTimes: {}, ...extra,
}, x);

/** Orders riders along the road; riders out on the road around sort among themselves, just behind the fork. */
const routeKey = (r) => roadX(r) + (r.spur ? (r.c - TOTAL) * 1e-4 : 0);

const BOT_WEIGHTS = [58, 70, 62, 79, 68, 84];

export class Game {
  /**
   * @param {{profile:{name,weight,ftp,maxHr}, workout:object, progress:object}} opts
   */
  constructor({ profile, workout, progress }) {
    this.profile = profile;
    this.workout = workout;
    this.progress = progress;
    this.mass = profile.weight + 9;

    this.clock = 0; // wall time since the ride screen opened
    this.t = 0; // active riding time (excludes pauses)
    this.wt = 0; // workout clock
    this.started = false;
    this.startedAt = 0; // wall-clock ms of the first pedal stroke
    this.paused = true;
    this.lastMove = 0;
    this.idle = 0;
    this.finished = false;

    this.user = mkRider(profile.name || 'You', '#ff3b6b', START, { isUser: true, kind: 'you', id: 'you', weight: profile.weight, ftp: profile.ftp });
    this.bots = BOTS.map((b, i) => mkRider(b.name, b.color, START + b.off, {
      lat: b.lat, f: b.f, i, ph: Math.random() * 6.28, weight: BOT_WEIGHTS[i % BOT_WEIGHTS.length], mass: BOT_WEIGHTS[i % BOT_WEIGHTS.length] + 9,
      ftp: Math.round(profile.ftp * (b.f + 0.12)), hr: 88, nextAttack: 40 + Math.random() * 60, attackUntil: 0,
    }));
    this.remotes = new Map(); // id -> { rider, net }
    this.coach = workout.steps.length
      ? mkRider('Coach', '#ffd400', START + 4, { isCoach: true, kind: 'coach', id: 'coach', weight: profile.weight, ftp: profile.ftp, mass: this.mass, lat: -0.6 })
      : null;

    // live values
    this.pw = 0; this.p3 = 0; this.pSmooth = 0;
    this.cad = 0; this.hr = null;
    this.spurIntent = false; // you have chosen to take the extension at the next turn point
    this.packUntil = -1; // until this clock time the bunch follows you onto the extension
    this.spurDone = 0; // detours ridden to their end
    this.spursDone = {}; // ... by detour id
    this.grade = gradeAt(this.user.c);
    this.pz = 0; this.hz = -1;

    // stats
    this.energy = 0; this.sumP = 0; this.sumHr = 0; this.hrTime = 0;
    this.maxP5 = 0; this.maxHr = 0;
    this.zonePow = new Array(7).fill(0);
    this.zoneHr = new Array(5).fill(0);
    this.draftTime = 0; this.orbCount = 0; this.segWins = 0; this.perfectIntervals = 0;
    this.samples = []; this.secP = 0; this.secHr = 0; this.secN = 0; this.secMark = 0;
    this.collected = new Set();
    this.lastOrbIdx = Math.floor(START / ORB_SPACING);

    // gamification
    this.target = null;
    this.onTarget = false;
    this.streak = 0; this.offTime = 0; this.mult = 1;
    this.score = 0;
    this.grace = 0;
    this.stepIdx = -1;
    this.stepStats = { t: 0, on: 0 };
    progress.discovered ||= {};
    this.biome = null;
    this.nearLm = new Set();
    this.discoveredNow = [];
    this.level = levelFor(progress.xp);
    this.unlocked = [];
    this.segEvents = [];
    this.curSeg = null;
    this.events = [];
    this.woDur = totalDuration(workout);
    this.wo = null;
  }

  get distance() { return this.user.x - START; }
  get totalXp() { return this.progress.xp + Math.floor(this.score); }

  drain() { const e = this.events; this.events = []; return e; }
  #toast(text, sub = '', kind = 'info') { this.events.push({ type: 'toast', text, sub, kind }); }
  #sfx(name) { this.events.push({ type: 'sfx', name }); }
  #award(points) { this.score += points * this.mult; }

  update(dt, inp) {
    this.clock += dt;
    const pw = Math.max(0, inp.power ?? 0);
    this.pw = pw;
    this.cad = inp.cadence ?? (pw > 0 ? 80 : 0);
    this.cadMeasured = inp.cadence ?? null; // what the sensor really said; this.cad is padded for the game
    this.hr = inp.hr ?? null;
    this.p3 += (pw - this.p3) * (1 - Math.exp(-dt / 3));
    this.pSmooth += (pw - this.pSmooth) * (1 - Math.exp(-dt / 0.8));
    this.user.p3 = this.p3; // the same fields every rider shares, for the sidebar and the network
    this.user.hr = this.hr;

    // Pedalling means real power or cadence (a spinning flywheel's last few rpm don't count).
    if (pw > 3 || this.cad > 8) {
      this.lastMove = this.clock;
      if (!this.started) { this.started = true; this.startedAt = Date.now(); this.#toast('Go!', 'Ride started', 'go'); this.#sfx('step'); }
    }
    this.idle = this.clock - this.lastMove; // seconds since the rider last pedalled
    this.paused = !this.started || this.idle > IDLE_PAUSE;
    const active = !this.paused && !this.finished;

    this.#physics(dt);
    this.#updateRemotes(dt);
    if (!this.paused) this.#updateBots(dt);
    this.#orbs();
    this.#segments();
    this.#world();

    this.pz = powerZone(this.pSmooth, this.profile.ftp);
    this.hz = this.hr != null ? hrZone(this.hr, this.profile.maxHr, this.profile.hrLimits) : -1;

    if (active) {
      this.t += dt;
      this.#stats(dt, pw);
      this.#workout(dt);
      this.#scoring(dt);
      if (this.t - this.secMark >= 1) { this.secMark += 1; this.#everySecond(); }
    }
    return this;
  }

  // ---- physics ----------------------------------------------------------------

  #physics(dt) {
    const riders = [this.user, ...this.bots, ...this.#remoteRiders()];
    const sorted = riders.slice().sort((a, b) => routeKey(a) - routeKey(b));
    sorted.forEach((r, i) => {
      r.drag = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (!sameStretch(r, sorted[j])) continue;
        const gap = gapBetween(r, sorted[j]);
        if (gap > 9) break;
        if (gap > 0.6) { r.drag = 0.65 + 0.35 * (gap / 9); break; }
      }
      r.drafting = r.drag < 0.95;
    });

    const u = this.user;
    if (!this.started || this.idle > IDLE_COAST) this.#brake(u, dt);
    else this.#advance(u, this.pSmooth, this.mass, dt);
    u.cad = this.cad;
    u.crank += (this.cad / 60) * Math.PI * 2 * dt;
    this.grade = gradeAt(u.c);
    this.elev = elevation(u.c);
    this.speed = u.v;

    if (this.coach) {
      const c = this.coach;
      c.drag = 1;
      const target = this.target ? this.target.watts : 0;
      if (this.paused) this.#brake(c, dt);
      else this.#advance(c, target, c.mass, dt);
      c.x = clamp(c.x, u.x - 60, u.x + 60);
      this.#followUser(c);
      c.cad = 88;
      c.crank += (88 / 60) * Math.PI * 2 * dt;
      c.p3 += (c.power - c.p3) * (1 - Math.exp(-dt / 3));
    }
  }

  /** Ride `dx` metres: the odometer counts them all, the rider's place on the course follows the road they are on. */
  #move(r, dx) {
    r.x += dx;
    if (r === this.coach || r.kind === 'remote' || dx <= 0) return;
    const take = r === this.user ? () => this.spurIntent : () => this.clock <= this.packUntil; // the choice applies to the next fork only
    for (const ev of advance(r, dx, take)) this.#turnEvent(r, ev);
  }

  /** The coach rides your route, a few metres from you. */
  #followUser(c) {
    const u = this.user;
    c.c = courseAt(u, c.x - u.x, this.spurIntent);
    c.spur = c.c >= LOOP;
    c.laps = u.laps + (!c.spur && !u.spur ? (c.c < u.c - 5000 ? 1 : c.c > u.c + 5000 ? -1 : 0) : 0);
  }

  #turnEvent(r, ev) {
    if (!r.isUser) return;
    const sp = SPURS[r.lastSpur];
    if (ev === 'enter') {
      this.spurIntent = false;
      this.packUntil = this.clock + PACK_FOLLOW;
      this.#sfx('segment');
    } else if (ev === 'pass') {
      this.spurIntent = false;
      this.#toast(sp.passText.title, sp.passText.sub, 'info');
    } else if (ev === 'exit') {
      this.spurDone++;
      this.spursDone[sp.id] = (this.spursDone[sp.id] ?? 0) + 1;
      this.#toast(sp.doneText.title, sp.doneText.sub, 'go');
      this.#sfx('step');
    }
  }

  /**
   * Where you are relative to the next fork (or on the detour you are riding), for the HUD and the controls. `spur` is the
   * detour the next fork leads onto.
   */
  extension() {
    const u = this.user;
    if (u.spur) {
      const sp = SPURS[spurAt(u.c)];
      return { state: 'on', spur: sp, done: u.c - sp.base, left: sp.end - u.c, length: sp.len, armed: false };
    }
    const sp = SPURS.find((s) => s.fork > u.c) ?? null; // none left this lap: the start line is next
    const toTurn = sp ? sp.fork - u.c : Infinity;
    return { state: toTurn <= TURN_RANGE ? 'approach' : 'far', spur: sp, toTurn, armed: this.spurIntent, length: sp?.len ?? 0 };
  }

  /** Choose (or un-choose) the detour at the next fork; only possible once the fork is announced. Returns the new choice. */
  toggleExtension(want = !this.spurIntent) {
    const e = this.extension();
    if (e.state !== 'approach') return this.spurIntent;
    if (want !== this.spurIntent) {
      this.spurIntent = want;
      const t = want ? e.spur.armText : e.spur.disarmText;
      this.#toast(t.title, t.sub, want ? 'go' : 'info');
      this.#sfx('step');
    }
    return this.spurIntent;
  }

  #brake(r, dt) {
    r.v = Math.max(0, r.v - BRAKE * dt);
    this.#move(r, r.v * dt);
    r.wheel += (r.v / 0.36) * dt;
    r.power = 0;
  }

  #advance(r, power, mass, dt) {
    const vt = speedFromPower(power, gradeAt(r.c), mass, r.drag);
    r.v += (vt - r.v) * (1 - Math.exp(-dt / 1.6));
    this.#move(r, r.v * dt);
    r.wheel += (r.v / 0.36) * dt;
    r.power = power;
  }

  #updateBots(dt) {
    const { ftp } = this.profile;
    for (const b of this.bots) {
      let p = b.f * ftp * (1 + 0.1 * Math.sin((this.clock / (40 + b.i * 9)) * Math.PI * 2 + b.ph));
      if (this.clock > b.nextAttack) {
        b.attackUntil = this.clock + 10 + Math.random() * 8;
        b.nextAttack = this.clock + 80 + Math.random() * 90;
      }
      const gap = gapBetween(this.user, b);
      if (this.clock < b.attackUntil && Math.abs(gap) < 60) p *= 1.45;
      p *= 1 - clamp(gap / 1500, -0.2, 0.2); // keep the pack in play
      this.#advance(b, p, b.mass, dt);
      b.cad = clamp(80 + 25 * (p / ftp - 0.7), 65, 105);
      b.crank += (b.cad / 60) * Math.PI * 2 * dt;
      b.p3 += (b.power - b.p3) * (1 - Math.exp(-dt / 3));
      const hrTarget = 66 + (176 - 66) * Math.min(1, (b.power / (b.ftp * 1.05)) ** 0.9); // a plausible heart rate for their effort
      b.hr += (hrTarget - b.hr) * (1 - Math.exp(-dt / 20));
    }
  }

  // ---- remote riders (multiplayer groundwork; see net.js) ----------------------------------------

  #remoteRiders() { return [...this.remotes.values()].map((e) => e.rider); }

  /** Everyone on the road: you, the bunch, the coach and any remote riders. */
  allRiders() {
    return [this.user, ...this.bots, ...(this.coach ? [this.coach] : []), ...this.#remoteRiders()];
  }

  /** Feed a state received from the network. Unknown riders join automatically; bad states are ignored. */
  applyRemote(raw) {
    const s = sanitizeState(raw);
    if (!s) return false;
    let e = this.remotes.get(s.id);
    if (!e) {
      const rider = mkRider(s.name, s.color, s.x, { id: s.id, kind: 'remote', weight: s.weight, ftp: s.ftp, lat: s.lat });
      e = { rider, net: new RemoteRider(s) };
      this.remotes.set(s.id, e);
      this.#toast(s.name, 'joined the ride', 'info');
    }
    e.net.push(s, this.clock * 1000);
    return true;
  }

  removeRemote(id) {
    const e = this.remotes.get(id);
    if (e) { this.remotes.delete(id); this.#toast(e.rider.name, 'left the ride', 'info'); }
  }

  #updateRemotes(dt) {
    for (const { rider: r, net } of this.remotes.values()) {
      const st = net.sample(this.clock * 1000);
      if (!st) continue;
      placeOnLoop(r, st.x); // remote riders always ride the loop
      r.x = st.x; r.lat = st.lat; r.v = st.speed; r.power = st.power; r.cad = st.cad; r.hr = st.hr;
      r.weight = st.weight; r.ftp = st.ftp; r.name = st.name; r.color = st.color;
      r.p3 += (st.power - r.p3) * (1 - Math.exp(-dt / 3));
      r.crank += (r.cad / 60) * Math.PI * 2 * dt;
      r.wheel += (r.v / 0.36) * dt;
    }
  }

  // ---- orbs & segments --------------------------------------------------------

  #orbs() {
    const u = this.user;
    const idx = Math.floor(u.x / ORB_SPACING);
    for (let i = this.lastOrbIdx; i <= idx; i++) {
      const o = orbAt(i);
      if (!o || this.collected.has(i) || o.x > u.x || o.x < u.x - 8) continue;
      this.collected.add(i);
      this.orbCount++;
      this.score += o.gold ? 10 : 2; // orbs are a flat bonus; the combo multiplier rewards steady riding
      this.events.push({ type: 'orb', x: o.x, h: o.h, gold: o.gold });
      this.#sfx(o.gold ? 'gold' : 'orb');
    }
    this.lastOrbIdx = idx;
  }

  #segments() {
    const riders = [this.user, ...this.bots, ...this.#remoteRiders()];
    for (const r of riders) {
      const phase = r.c;
      for (const s of SEGMENTS) {
        const inside = r.spur === (s.start >= LOOP) && (!r.spur || spurAt(r.c) === spurAt(s.start)) && phase >= s.start && phase < s.end;
        const was = r.segStart[s.id] != null;
        if (inside && !was) {
          r.segStart[s.id] = this.clock;
          if (r.isUser) {
            this.#toast(s.name.toUpperCase(), s.kind === 'climb' ? 'Climb segment started' : 'Sprint segment started', 'seg');
            this.#sfx('segment');
          }
        } else if (!inside && was) {
          const time = this.clock - r.segStart[s.id];
          r.segStart[s.id] = null;
          if (time > 3) r.segTimes[s.id] = time;
          if (r.isUser && time > 3) this.#finishSegment(s, time);
        }
      }
    }
    const phase = this.user.c;
    const s = SEGMENTS.find((q) => this.user.spur === (q.start >= LOOP) && phase >= q.start && phase < q.end);
    this.curSeg = s
      ? { seg: s, progress: (phase - s.start) / (s.end - s.start), elapsed: this.clock - (this.user.segStart[s.id] ?? this.clock) }
      : null;
  }

  #finishSegment(seg, time) {
    const all = [this.user, ...this.bots].filter((r) => r.segTimes[seg.id] != null).sort((a, b) => a.segTimes[seg.id] - b.segTimes[seg.id]);
    const rank = all.indexOf(this.user) + 1;
    const pr = this.progress.segPR[seg.id];
    const isPR = pr == null || time < pr;
    if (isPR) this.progress.segPR[seg.id] = time;
    const pts = [0, 300, 200, 100][rank] ?? 50;
    this.#award(pts);
    if (rank === 1 && all.length > 1) { this.segWins++; this.#sfx('win'); } else this.#sfx('segment');
    const medal = rank === 1 ? 'Segment win!' : `Finished ${rank}${['st', 'nd', 'rd'][rank - 1] || 'th'} of ${all.length}`;
    this.#toast(seg.name, `${medal}  ·  ${time.toFixed(1)}s${isPR ? '  ·  NEW PR' : ''}  ·  +${pts * this.mult}`, rank === 1 ? 'win' : 'seg');
  }

  /** Zone changes and landmark discoveries. */
  #world() {
    const phase = this.user.c;
    const bi = biomeIndex(phase);
    if (bi !== this.biome) {
      this.biome = bi;
      this.#toast(BIOMES[bi].name.toUpperCase(), BIOMES[bi].blurb, 'zone');
    }
    for (const lm of LANDMARKS) {
      const lmSpur = spurAt(lm.d);
      let d = Math.abs(phase - lm.d);
      if (lmSpur !== spurAt(phase)) d = Infinity; // landmarks on a detour are only reachable from it
      else if (lmSpur < 0) d = Math.min(d, LOOP - d);
      const near = d < 35;
      if (near && !this.nearLm.has(lm.id)) {
        this.nearLm.add(lm.id);
        if (!this.progress.discovered[lm.id]) {
          this.progress.discovered[lm.id] = Date.now();
          this.discoveredNow.push(lm.id);
          this.score += 100;
          this.#toast(`${lm.emoji} ${lm.name}`, `Landmark discovered  ·  ${Object.keys(this.progress.discovered).length}/${LANDMARKS.length}  ·  +100`, 'ach');
          this.#sfx('ach');
        }
      } else if (d > 120) this.nearLm.delete(lm.id);
    }
  }

  // ---- stats, workout, scoring ------------------------------------------------

  #stats(dt, pw) {
    this.energy += pw * dt;
    this.sumP += pw * dt;
    this.zonePow[powerZone(pw, this.profile.ftp)] += dt;
    if (this.hr != null) {
      this.sumHr += this.hr * dt;
      this.hrTime += dt;
      this.maxHr = Math.max(this.maxHr, this.hr);
      this.zoneHr[hrZone(this.hr, this.profile.maxHr, this.profile.hrLimits)] += dt;
    }
    if (this.user.drafting) this.draftTime += dt;
    this.secP += pw; this.secN++;
    if (this.hr != null) this.secHr = this.hr;
  }

  #everySecond() {
    this.samples.push({ p: this.secN ? this.secP / this.secN : 0, hr: this.secHr || null, cad: this.cadMeasured, v: this.user.v, d: this.distance, c: this.user.c });
    this.secP = 0; this.secN = 0;
    const last5 = this.samples.slice(-5);
    if (last5.length === 5) this.maxP5 = Math.max(this.maxP5, last5.reduce((a, s) => a + s.p, 0) / 5);

    for (const a of ACHIEVEMENTS) {
      if (this.progress.ach[a.id] || this.unlocked.includes(a.id)) continue;
      if (a.test(this)) {
        this.unlocked.push(a.id);
        this.progress.ach[a.id] = Date.now();
        this.score += 250;
        this.#toast(a.name, `Achievement unlocked  ·  ${a.desc}`, 'ach');
        this.#sfx('ach');
      }
    }
    const lvl = levelFor(this.totalXp);
    if (lvl > this.level) {
      this.level = lvl;
      this.#toast(`LEVEL ${lvl}`, 'Level up!', 'level');
      this.#sfx('level');
    }
  }

  #workout(dt) {
    if (!this.workout.steps.length) { this.target = null; return; }
    this.wt += dt;
    const w = workoutAt(this.workout, this.wt, this.profile.ftp);
    this.wo = w;
    if (w.done) {
      if (!this.finished) {
        this.#closeStep();
        this.finished = true;
        this.#toast('WORKOUT COMPLETE', 'Nice work!', 'win');
        this.#sfx('win');
      }
      return;
    }
    this.target = { watts: w.watts, tol: Math.max(12, w.watts * 0.06), label: w.step.label };
    if (w.idx !== this.stepIdx) {
      this.#closeStep();
      this.stepIdx = w.idx;
      this.stepStats = { t: 0, on: 0, dur: w.step.dur };
      this.grace = 6;
      if (w.idx > 0) {
        const len = w.step.dur < 90 ? `${w.step.dur}s` : `${Math.round(w.step.dur / 60)} min`;
        this.#toast(w.step.label || 'Next interval', `${len} @ ${w.watts} W`, 'step');
        this.#sfx('step');
      }
    }
  }

  #closeStep() {
    const s = this.stepStats;
    if (s && s.dur >= 30 && s.t > 0 && s.on / s.t >= 0.9 && this.target) {
      this.perfectIntervals++;
      this.#award(100);
      this.#toast('PERFECT INTERVAL', `${Math.round((s.on / s.t) * 100)}% on target  ·  +${100 * this.mult}`, 'win');
      this.#sfx('win');
    }
  }

  #scoring(dt) {
    const { ftp } = this.profile;
    this.grace = Math.max(0, this.grace - dt);
    const t = this.target;
    const on = t ? Math.abs(this.p3 - t.watts) <= t.tol : this.p3 > 0.35 * ftp;
    this.onTarget = on;
    if (t) { this.stepStats.t += dt; if (on) this.stepStats.on += dt; }

    const prevMult = this.mult;
    if (on) { this.streak += dt; this.offTime = 0; }
    else if (this.grace <= 0) {
      this.offTime += dt;
      if (this.offTime > 5) { this.streak = 0; this.offTime = 0; }
    }
    this.mult = Math.min(5, 1 + Math.floor(this.streak / 30));
    if (this.mult > prevMult) { this.#toast(`COMBO x${this.mult}`, 'Keep it steady!', 'combo'); this.#sfx('combo'); }

    const rate = t ? (on ? 1 : 0) : 0.15 + 0.15 * this.pz;
    this.score += rate * this.mult * dt;
  }

  // ---- views for the HUD ------------------------------------------------------

  /** All riders ordered front to back with their gap to the user (metres, + = ahead). */
  /**
   * Everyone ordered front to back. `gap` is metres ahead (+) or behind (-) of you; `gapSec` estimates the
   * time to close it at the chaser's speed.
   */
  board() {
    return this.allRiders()
      .map((r) => {
        const gap = r === this.user ? 0 : gapBetween(this.user, r);
        const chaser = gap > 0 ? this.user.v : r.v;
        return { r, gap, gapSec: gap / Math.max(3, chaser) };
      })
      .sort((a, b) => b.gap - a.gap || routeKey(b.r) - routeKey(a.r));
  }

  summary() {
    const dur = this.t || 1;
    return {
      time: this.t,
      distance: this.distance,
      avgPower: this.sumP / dur,
      maxP5: this.maxP5,
      avgHr: this.hrTime ? this.sumHr / this.hrTime : null,
      maxHr: this.maxHr || null,
      kj: this.energy / 1000,
      score: Math.floor(this.score),
      orbs: this.orbCount,
      draftTime: this.draftTime,
      segWins: this.segWins,
      zonePow: this.zonePow,
      zoneHr: this.zoneHr,
      samples: this.samples,
      extensions: this.spurDone,
      detours: this.spursDone,
      unlocked: this.unlocked,
      discovered: this.discoveredNow,
      workout: this.workout,
      completed: this.finished,
    };
  }
}
