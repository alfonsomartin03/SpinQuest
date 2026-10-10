// Groundwork for multiplayer. There is no server yet; this defines what travels between riders and how
// a remote rider is smoothed on screen, and ships a loopback session (with latency and jitter) that the
// tests and the demo use.
//
// Design in short:
//  * Each client simulates only its own rider and publishes a small state ~10 times a second.
//  * Everyone else is a RemoteRider: a short buffer of timestamped states, drawn slightly in the past so
//    the motion between packets is smooth (interpolation), with brief extrapolation if a packet is late.
//  * The wire format is plain JSON with a version number, validated on arrival so a bad or hostile client
//    can't push NaNs or teleport. A real server should also check plausibility (speed vs power) before
//    relaying.

import { speedFromPower, gradeAt, LOOP, V_MAX } from './physics.js';

export const PROTOCOL_VERSION = 1;
export const SEND_HZ = 10;
export const INTERP_DELAY = 0.15; // seconds behind real time, enough to span one or two packets
const MAX_EXTRAPOLATE = 0.3; // seconds
const MAX_SPEED = V_MAX + 1; // m/s: anything faster in a state is rejected as bogus (the physics tops out at V_MAX)

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Turn a rider into the state we send. `r` is a game rider; extra fields come from the game. */
export function packRider(r, { power, hr = null, now }) {
  return {
    v: PROTOCOL_VERSION,
    id: r.id,
    name: r.name,
    color: r.color,
    t: now, // sender clock (ms)
    x: r.x, // distance along the loop (m)
    lat: r.lat ?? 0,
    speed: r.v,
    power,
    cad: r.cad,
    hr,
    weight: r.weight,
    ftp: r.ftp,
  };
}

/** Validate and clamp an incoming state. Returns null if it can't be trusted. */
export function sanitizeState(s) {
  if (!s || s.v !== PROTOCOL_VERSION || typeof s.id !== 'string' || !s.id || s.id.length > 64) return null;
  for (const k of ['t', 'x', 'speed', 'power', 'cad', 'weight', 'ftp']) if (!finite(s[k])) return null;
  if (s.speed < 0 || s.speed > MAX_SPEED) return null;
  return {
    v: s.v,
    id: s.id,
    name: String(s.name ?? 'Rider').slice(0, 16),
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#cccccc',
    t: s.t,
    x: s.x,
    lat: clamp(finite(s.lat) ? s.lat : 0, -4, 4),
    speed: s.speed,
    power: clamp(s.power, 0, 2500),
    cad: clamp(s.cad, 0, 200),
    hr: finite(s.hr) ? clamp(s.hr, 30, 230) : null,
    weight: clamp(s.weight, 30, 200),
    ftp: clamp(s.ftp, 40, 600),
  };
}

/**
 * Smooths one remote rider. States arrive late, bunched or out of order; `sample()` returns where the
 * rider should be drawn now.
 */
export class RemoteRider {
  constructor(first = null) {
    this.buf = [];
    this.offset = null; // estimated (local ms) - (sender ms)
    this.info = first ? { id: first.id, name: first.name, color: first.color } : null;
    this.lastX = null;
  }

  /** @param {object} state a sanitised state; @param {number} localMs when it arrived (local clock) */
  push(state, localMs) {
    const off = localMs - state.t;
    // the smallest offset ever seen is the best estimate of the true clock difference (least network delay);
    // otherwise let it drift up slowly to follow clock drift
    if (this.offset == null || off < this.offset) this.offset = off;
    else this.offset += (off - this.offset) * 0.002;
    if (this.buf.length && state.t <= this.buf[this.buf.length - 1].t) return false; // old or duplicate
    this.buf.push(state);
    if (this.buf.length > 40) this.buf.shift();
    this.info = { id: state.id, name: state.name, color: state.color };
    return true;
  }

  get ready() { return this.buf.length > 0; }

  /** The state to show at local time `localMs`. */
  sample(localMs, delay = INTERP_DELAY) {
    if (!this.buf.length) return null;
    const target = localMs - this.offset - delay * 1000; // in sender time
    const b = this.buf;
    if (target <= b[0].t) return { ...b[0] };
    const last = b[b.length - 1];
    if (target >= last.t) { // starved: carry on at the last known speed, but not for long
      const dt = Math.min((target - last.t) / 1000, MAX_EXTRAPOLATE);
      return { ...last, x: last.x + last.speed * dt, extrapolated: true };
    }
    let i = b.length - 1;
    while (i > 0 && b[i - 1].t > target) i--;
    const a = b[i - 1], c = b[i];
    const k = (target - a.t) / (c.t - a.t);
    const mix = (u, v) => u + (v - u) * k;
    return {
      ...c,
      x: mix(a.x, c.x), lat: mix(a.lat, c.lat), speed: mix(a.speed, c.speed), power: mix(a.power, c.power),
      cad: mix(a.cad, c.cad), hr: a.hr != null && c.hr != null ? mix(a.hr, c.hr) : c.hr,
    };
  }
}

/**
 * An in-memory "network" with latency and jitter, shaped like a real session so a WebSocket one can
 * replace it: publish() your state, subscribe with onState().
 */
export class LoopbackSession {
  constructor({ latencyMs = 60, jitterMs = 25, now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
    Object.assign(this, { latencyMs, jitterMs, now, schedule });
    this.listeners = new Set();
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  publish(state) {
    const delay = this.latencyMs + Math.random() * this.jitterMs;
    const copy = JSON.parse(JSON.stringify(state)); // what a socket would do
    this.schedule(() => { for (const fn of this.listeners) fn(copy); }, delay);
  }
}

/**
 * Simulated people for the demo: each rides at their own pace and publishes states into a session, so the
 * whole remote-rider path (network -> smoothing -> sidebar -> 3D model) can be seen without a server.
 */
export class DemoPeers {
  constructor(session, { count = 3, startX = 0, now = () => performance.now() } = {}) {
    this.session = session;
    this.now = now;
    const names = ['Sam', 'Lena', 'Omar', 'Kai', 'Nia'];
    const colors = ['#4cc9f0', '#f72585', '#b5e48c', '#ff9e00', '#a78bfa'];
    this.peers = Array.from({ length: count }, (_, i) => ({
      id: `demo-${i + 1}`, name: names[i % names.length], color: colors[i % colors.length], x: startX + 20 + i * 25, lat: [-2.2, 2.6, -1.1, 1.4, 0][i % 5],
      weight: 62 + i * 9, ftp: 190 + i * 40, ph: i * 1.7, speed: 8,
    }));
    this.acc = 0;
  }

  /** Advance the peers by dt seconds and publish at SEND_HZ. */
  tick(dt) {
    const t = this.now() / 1000;
    for (const p of this.peers) {
      const w = (0.62 + 0.18 * Math.sin(t / 37 + p.ph) + (Math.sin(t / 9 + p.ph * 2) > 0.92 ? 0.35 : 0)) * p.ftp;
      p.power = Math.max(0, w);
      p.speed = speedFromPower(p.power, gradeAt(((p.x % LOOP) + LOOP) % LOOP), p.weight + 9);
      p.x += p.speed * dt;
      p.cad = 82 + 14 * Math.sin(t / 6 + p.ph);
      p.hr = 70 + (185 - 70) * Math.min(1, (p.power / p.ftp) ** 0.9) * 0.92;
    }
    this.acc += dt;
    if (this.acc >= 1 / SEND_HZ) {
      this.acc = 0;
      for (const p of this.peers) {
        this.session.publish({ v: PROTOCOL_VERSION, id: p.id, name: p.name, color: p.color, t: this.now(), x: p.x, lat: p.lat, speed: p.speed, power: p.power, cad: p.cad, hr: p.hr, weight: p.weight, ftp: p.ftp });
      }
    }
  }
}
