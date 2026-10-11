// Web Bluetooth: smart trainers / power meters (FTMS, Cycling Power) and heart rate straps.
// Read-only: we never write to the trainer, so the user stays in control of resistance.

export const UUID = {
  FTMS: 0x1826,
  INDOOR_BIKE_DATA: 0x2ad2,
  CPS: 0x1818,
  CP_MEASUREMENT: 0x2a63,
  HRS: 0x180d,
  HR_MEASUREMENT: 0x2a37,
  FTMS_CONTROL: 0x2ad9,
  FTMS_FEATURE: 0x2acc,
};

import { ZapSession, clickButtonsFrom } from './zwiftcrypto.js';

// Zwift Click (the handlebar shifter): a custom Zwift service. Writing "RideOn" to the sync-rx characteristic
// starts it sending button frames. Protocol per the community reverse engineering (qdomyos-zwift's zwift_play).
export const ZWIFT = {
  SERVICE: '00000001-19ca-4651-86e5-fa29dcdd09d1',
  ASYNC: '00000002-19ca-4651-86e5-fa29dcdd09d1',
  SYNC_RX: '00000003-19ca-4651-86e5-fa29dcdd09d1',
  SYNC_TX: '00000004-19ca-4651-86e5-fa29dcdd09d1',
  MANUFACTURER: 0x094a, // 2378, Zwift, Inc
  RIDE_ON: Uint8Array.of(0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e),
};

// ---- Parsers (pure functions, unit tested) ---------------------------------

/** FTMS Indoor Bike Data. Returns any of {speed (km/h), cadence (rpm), power (W), hr (bpm)}. */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  if (!(flags & 0x001)) { out.speed = dv.getUint16(o, true) / 100; o += 2; } // bit0 = "more data" (inverted)
  if (flags & 0x002) o += 2; // average speed
  if (flags & 0x004) { out.cadence = dv.getUint16(o, true) / 2; o += 2; }
  if (flags & 0x008) o += 2; // average cadence
  if (flags & 0x010) o += 3; // total distance
  if (flags & 0x020) o += 2; // resistance level
  if (flags & 0x040) { out.power = dv.getInt16(o, true); o += 2; }
  if (flags & 0x080) o += 2; // average power
  if (flags & 0x100) o += 5; // expended energy
  if (flags & 0x200) { out.hr = dv.getUint8(o); o += 1; }
  return out;
}

/** Cycling Power Measurement. `state` carries crank counters between packets for cadence. */
export function parseCyclingPower(dv, state = {}) {
  const flags = dv.getUint16(0, true);
  const out = { power: dv.getInt16(2, true) };
  let o = 4;
  if (flags & 0x001) o += 1; // pedal power balance
  if (flags & 0x004) o += 2; // accumulated torque
  if (flags & 0x010) o += 6; // wheel revolution data
  if (flags & 0x020) {
    const revs = dv.getUint16(o, true);
    const time = dv.getUint16(o + 2, true); // 1/1024 s
    if (state.revs != null) {
      const dr = (revs - state.revs + 65536) % 65536;
      const dt = (time - state.time + 65536) % 65536;
      if (dt > 0) {
        state.cadence = (dr / (dt / 1024)) * 60;
        state.idle = 0;
      } else if (++state.idle > 4) {
        state.cadence = 0;
      }
      out.cadence = state.cadence ?? 0;
    }
    state.revs = revs;
    state.time = time;
  }
  return out;
}

/** Heart Rate Measurement. */
export function parseHeartRate(dv) {
  return { hr: dv.getUint8(0) & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1) };
}

/**
 * Zwift Click button frame: 0x37, then two button bytes (at 2 and 4) that read 0 while that button is held.
 * Returns the buttons that were just pressed: 'plus' (right, harder) and/or 'minus' (left, easier).
 * `state` remembers what was held so a held button fires once.
 */
export function parseClickButtons(dv, state = {}) {
  if (dv.byteLength < 5 || dv.getUint8(0) !== 0x37) return [];
  const plus = dv.getUint8(2) === 0;
  const minus = dv.getUint8(4) === 0;
  const out = [];
  if (plus && !state.plus) out.push('plus');
  if (minus && !state.minus) out.push('minus');
  state.plus = plus;
  state.minus = minus;
  return out;
}

// ---- FTMS control point (resistance control) ------------------------------------------------

export const FTMS_OP = { REQUEST_CONTROL: 0x00, RESET: 0x01, SET_TARGET_POWER: 0x05, START: 0x07, STOP: 0x08, RESPONSE: 0x80 };

export const encodeTargetPower = (watts) => {
  const w = Math.max(0, Math.min(4000, Math.round(watts)));
  return Uint8Array.of(FTMS_OP.SET_TARGET_POWER, w & 0xff, (w >> 8) & 0xff);
};

/** Parse a control point indication: {op, ok, result} (result 0x01 = success, 0x05 = control not permitted). */
export function parseControlResponse(dv) {
  if (dv.byteLength < 3 || dv.getUint8(0) !== FTMS_OP.RESPONSE) return null;
  return { op: dv.getUint8(1), result: dv.getUint8(2), ok: dv.getUint8(2) === 0x01 };
}

/**
 * Sets the trainer's target power over the standard FTMS control point.
 * States: none (not controllable) -> idle (available) -> requesting -> ready | denied.
 */
export class TrainerControl {
  constructor() {
    this.state = 'none';
    this.reason = '';
    this.cp = null;
    this.lastW = null;
    this.onState = () => {};
    this.queue = Promise.resolve();
    this.timer = null;
  }

  #set(state, reason = '') {
    this.state = state;
    this.reason = reason;
    this.onState(state, reason);
  }

  /** Discover the control point on an FTMS service (called on every (re)connect). */
  async attach(service) {
    this.cp = null;
    this.lastW = null;
    try {
      const cp = await service.getCharacteristic(UUID.FTMS_CONTROL);
      let canTarget = true;
      try {
        const dv = await (await service.getCharacteristic(UUID.FTMS_FEATURE)).readValue();
        canTarget = dv.byteLength >= 8 ? !!(dv.getUint32(4, true) & (1 << 3)) : true; // target-setting bit 3 = power target
      } catch { /* feature read is optional */ }
      if (!canTarget) { this.#set('none', 'This trainer cannot hold a target power.'); return; }
      cp.addEventListener('characteristicvaluechanged', (e) => this.#onIndication(e.target.value));
      await cp.startNotifications();
      this.cp = cp;
      this.#set('idle');
    } catch {
      this.#set('none', 'This device has no trainer control.');
    }
  }

  /** Ask the trainer for control (call when a ride starts). */
  acquire() {
    if (this.state !== 'idle' || !this.cp) return;
    this.#set('requesting');
    this.#write(Uint8Array.of(FTMS_OP.REQUEST_CONTROL));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { // some trainers never indicate; assume we have control
      if (this.state === 'requesting') { this.#write(Uint8Array.of(FTMS_OP.START)); this.#set('ready'); }
    }, 3000);
  }

  setTargetPower(watts) {
    if (this.state !== 'ready') return;
    const w = Math.round(watts);
    if (w === this.lastW) return;
    this.lastW = w;
    this.#write(encodeTargetPower(w));
  }

  /** Give resistance back to the rider (call when a ride ends). */
  release() {
    clearTimeout(this.timer);
    if (this.cp && (this.state === 'ready' || this.state === 'requesting')) {
      this.#write(encodeTargetPower(0));
      this.#write(Uint8Array.of(FTMS_OP.STOP, 0x01));
      this.#write(Uint8Array.of(FTMS_OP.RESET));
      this.lastW = null;
      this.#set('idle');
    }
  }

  #onIndication(dv) {
    const r = parseControlResponse(dv);
    if (!r) return;
    if (r.op === FTMS_OP.REQUEST_CONTROL) {
      clearTimeout(this.timer);
      if (r.ok) { this.#write(Uint8Array.of(FTMS_OP.START)); this.#set('ready'); }
      else this.#set('denied', r.result === 0x05 ? 'Another app has control of this trainer.' : 'The trainer refused control.');
    } else if (r.op === FTMS_OP.SET_TARGET_POWER && !r.ok && r.result === 0x05) {
      this.#set('idle'); // lost control: re-acquire next tick
    }
  }

  #write(bytes) {
    // GATT allows one operation at a time, so writes are chained
    this.queue = this.queue
      .then(() => (this.cp.writeValueWithResponse ? this.cp.writeValueWithResponse(bytes) : this.cp.writeValue(bytes)))
      .catch(() => {});
  }
}

// ---- Connections -------------------------------------------------------------

export const bluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** Why Bluetooth can't be used here, in plain words (or null if it can). */
export function bluetoothProblem() {
  if (bluetoothSupported()) return null;
  if (location.protocol === 'file:') return 'Run "python3 serve.py" and open http://localhost:8000. Double-clicking index.html won\'t work.';
  if (!window.isSecureContext) return `Bluetooth needs http://localhost:8000 (or https). This page is on ${location.origin}.`;
  return 'This browser can\'t use Bluetooth. Switch to Google Chrome or Microsoft Edge.';
}

/** Turn a Web Bluetooth error into advice the rider can act on. */
export function explainError(err) {
  const msg = err?.message || String(err);
  if (err?.name === 'NotFoundError') return 'No device picked. Wake it up (spin the pedals) and try again. Not listed? Try "Search all devices".';
  if (err?.name === 'SecurityError') return 'Bluetooth is blocked. Allow it for your browser in your system settings, then try again.';
  if (err?.name === 'NetworkError') return 'Found it, but could not connect. Wake it up, close any other app using it, then try again.';
  if (/No supported power service/.test(msg)) return 'That is not a trainer or power meter. Pick your trainer or power meter from the list.';
  return `Could not connect. ${msg}`;
}

// Chrome's picker lists every device matching ANY filter. Matching on the standard service keeps
// out phones, TVs and earbuds, and the brand prefixes catch devices that don't advertise services.
const TRAINER_NAMES = [
  'KICKR', 'Wahoo', 'Tacx', 'NEO', 'FLUX', 'Zwift', 'Elite', 'Direto', 'Suito', 'Justo', 'Saris', 'CycleOps', 'Hammer',
  'JetBlack', 'Kinetic', 'Wattbike', 'Atom', 'Stages', 'Assioma', 'Favero', '4iiii', 'Rotor', 'Quarq', 'SRM', 'Power2Max',
  'Magene', 'Bkool', 'BKOOL', 'Thinkrider', 'Xplova', 'Onelap', 'Zycle', 'Peloton', 'Echelon', 'Schwinn', 'Domyos', 'Vector',
];
const HR_NAMES = [
  'Polar', 'H10', 'H9', 'OH1', 'Verity', 'HRM', 'TICKR', 'COOSPO', 'Coospo', 'Magene', 'Scosche', 'Rhythm', 'Suunto',
  'WHOOP', 'Whoop', 'Myzone', 'Zephyr', 'Garmin', 'Moofit', 'Geonaute', 'Decathlon', 'Viiiiva', 'HW', 'CL',
];

async function request(kind, all) {
  const optionalServices = [UUID.FTMS, UUID.CPS, UUID.HRS, ZWIFT.SERVICE];
  if (kind === 'click') {
    if (all) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [ZWIFT.SERVICE] }, { manufacturerData: [{ companyIdentifier: ZWIFT.MANUFACTURER }] }, { namePrefix: 'Zwift' }],
      optionalServices,
    });
  }
  if (all) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  const services = kind === 'hr' ? [UUID.HRS] : [UUID.FTMS, UUID.CPS];
  const names = kind === 'hr' ? HR_NAMES : TRAINER_NAMES;
  const opts = {
    filters: [...services.map((s) => ({ services: [s] })), ...names.map((n) => ({ namePrefix: n }))],
    optionalServices,
  };
  // the heart-rate list shouldn't show trainers or power meters (older Chromes ignore this)
  if (kind === 'hr') opts.exclusionFilters = [{ services: [UUID.FTMS] }, { services: [UUID.CPS] }];
  return navigator.bluetooth.requestDevice(opts);
}

/** Devices this browser was already allowed to use (Chrome with persistent permissions). */
export async function getKnownDevices() {
  try { return (await navigator.bluetooth.getDevices?.()) || []; } catch { return []; }
}

/** A remembered device only connects once it is advertising again; wait for that briefly. */
async function awaken(device) {
  if (!device.watchAdvertisements) return;
  const ac = new AbortController();
  try {
    await device.watchAdvertisements({ signal: ac.signal });
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 7000);
      device.addEventListener('advertisementreceived', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  } catch { /* connect anyway */ } finally { ac.abort(); }
}

/**
 * A device link that survives drops: it re-subscribes after reconnecting.
 * `subscribe(server)` must start the notifications.
 */
class Link {
  constructor(device, subscribe, onStatus) {
    this.device = device;
    this.subscribe = subscribe;
    this.onStatus = onStatus;
    this.closed = false;
    device.addEventListener('gattserverdisconnected', () => this.#dropped());
  }

  get name() { return this.device.name || 'Device'; }

  async open() {
    let server;
    for (let attempt = 1; ; attempt++) { // GATT connects often fail once on first try
      try { server = await this.device.gatt.connect(); break; } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    await this.subscribe(server);
    this.onStatus('connected', this.name);
  }

  async #dropped() {
    if (this.closed) return;
    for (let attempt = 1; attempt <= 12 && !this.closed; attempt++) {
      this.onStatus('reconnecting', this.name);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 6000)));
      try { await this.open(); return; } catch { /* try again */ }
    }
    if (!this.closed) this.onStatus('lost', this.name);
  }

  close() {
    this.closed = true;
    this.control?.release();
    if (this.device.gatt.connected) this.device.gatt.disconnect();
    this.onStatus('idle', '');
  }
}

async function notify(service, charId, handler) {
  const ch = await service.getCharacteristic(charId);
  ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
  await ch.startNotifications();
}

/**
 * Connect a smart trainer or power meter. `emit` receives partial {power, cadence, speed, hr}.
 * The returned link has `.control` (a TrainerControl) for resistance control.
 */
export async function connectTrainer(emit, onStatus, { all = false, device = null, onLog = () => {} } = {}) {
  if (device) await awaken(device);
  device ||= await request('trainer', all);
  onLog(`chose ${device.name || 'a device'}`);
  const cpState = {};
  const control = new TrainerControl();
  let packets = 0, last = {}, timer = null;
  // what the trainer is sending, once every couple of seconds, so a connected trainer that shows no power can be diagnosed
  const report = () => {
    const bits = [`${packets} packets`, last.power != null ? `power ${last.power} W` : 'no power in them', last.cadence != null ? `cadence ${Math.round(last.cadence)} rpm` : 'no cadence', last.speed != null ? `speed ${last.speed.toFixed(1)} km/h` : null].filter(Boolean);
    onLog(`receiving: ${bits.join(' · ')}`, 'status');
  };
  const seen = (d) => { packets++; last = { ...last, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) }; };
  const link = new Link(device, async (server) => {
    let ftmsPower = false;
    let ftmsPackets = 0;
    let cpsStarted = false;
    clearInterval(timer);
    timer = setInterval(report, 2000);
    const startCps = async () => {
      if (cpsStarted) return;
      cpsStarted = true;
      try {
        const cps = await server.getPrimaryService(UUID.CPS);
        await notify(cps, UUID.CP_MEASUREMENT, (dv) => { const d = parseCyclingPower(dv, cpState); seen(d); emit(d); });
        onLog('listening to its Cycling Power service');
      } catch (err) { onLog(`no Cycling Power service (${err.name})`); }
    };
    try {
      const ftms = await server.getPrimaryService(UUID.FTMS);
      onLog('found the Fitness Machine (FTMS) service');
      await notify(ftms, UUID.INDOOR_BIKE_DATA, (dv) => {
        const d = parseIndoorBikeData(dv);
        ftmsPackets++;
        if (d.power != null) ftmsPower = true;
        if (ftmsPackets === 1) onLog(`first reading: ${Object.entries(d).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing we understand'}`);
        if (ftmsPackets === 4 && !ftmsPower) { onLog('its readings carry no power, so also trying Cycling Power'); startCps(); } // FTMS without power: fall back to CPS
        seen(d);
        emit(d);
      });
      onLog('listening to Indoor Bike Data');
      try { await control.attach(ftms); onLog('resistance control attached'); } catch (err) { onLog(`resistance control not available (${err.message})`); }
      setTimeout(() => { if (!ftmsPackets && !link.closed) onLog('no readings yet. Pedal to wake the trainer. If it still says nothing, another app (Zwift, a phone) may be using it.'); }, 6000);
      return;
    } catch (err) { onLog(`no usable FTMS service (${err.name}: ${err.message})`); }
    await startCps();
    if (!cpsStarted) throw new Error('No supported power service on this device');
  }, onStatus);
  link.control = control;
  await link.open();
  return link;
}

/** Connect a heart rate strap/watch broadcasting the standard Heart Rate service. */
export async function connectHeartRate(emit, onStatus, { all = false, device = null } = {}) {
  if (device) await awaken(device);
  device ||= await request('hr', all);
  const link = new Link(device, async (server) => {
    const svc = await server.getPrimaryService(UUID.HRS);
    await notify(svc, UUID.HR_MEASUREMENT, (dv) => emit(parseHeartRate(dv)));
  }, onStatus);
  await link.open();
  return link;
}

const hex = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Connect a Zwift Click. `onShift(+1 | -1)` fires on each press (+1 = right button, harder). `onLog(text)` narrates the
 * connection and every frame the Click sends (as hex), so a Click that connects but does nothing can be diagnosed.
 *
 * Two kinds of Click: the original sends its buttons as plain bytes after a "RideOn" greeting; the newer one answers only
 * an encrypted handshake (see zwiftcrypto.js) and sends the same button message encrypted. Both are handled here: we open
 * with the encrypted handshake, and fall back to the plain greeting if nothing answers.
 */
export async function connectClick(onShift, onStatus, { all = false, device = null, onRaw = null, onLog = () => {} } = {}) {
  if (device) await awaken(device);
  device ||= await request('click', all);
  onLog(`chose ${device.name || 'a device'}`);
  const link = new Link(device, async (server) => {
    onLog('connected, looking for the Zwift service');
    const svc = await server.getPrimaryService(ZWIFT.SERVICE).catch((err) => { onLog(`no Zwift service on it (${err.name}). Is this the Click?`); throw err; });
    const held = {}; // which buttons are down, so a held button fires once
    const press = (plus, minus) => {
      if (plus && !held.plus) { onLog('press: + (harder)'); onShift(1); }
      if (minus && !held.minus) { onLog('press: - (easier)'); onShift(-1); }
      held.plus = plus; held.minus = minus;
    };
    let session = new ZapSession();
    let frames = 0, fails = 0, retries = 0;
    const handle = (via) => async (dv) => {
      frames++;
      const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      if (!session.recipe) onLog(`${via}: ${hex(dv)}`); // once messages decrypt, only the readable result is logged
      try {
        if (ZapSession.isReply(bytes)) {
          await session.accept(bytes);
          onLog('encrypted link is up: now press a button');
        } else if (bytes.length >= 6 && bytes.slice(0, 6).every((b, i) => b === ZWIFT.RIDE_ON[i])) {
          onLog('it answered the plain greeting');
        } else if (session.ready && bytes.length > 8) {
          const had = session.recipe;
          const plain = await session.decrypt(bytes);
          if (!had && session.recipe) onLog(`decrypted it (${session.recipe.name})`);
          const buttons = clickButtonsFrom(plain);
          if (buttons) press(buttons.plus, buttons.minus);
          else if (plain[0] === 0x19) { if (plain[2] !== held.battery) { held.battery = plain[2]; onLog(`battery ${plain[2]}%`); } }
          else onLog(`(message type ${plain[0].toString(16)}: ${hex(new DataView(plain.buffer))})`);
        } else {
          const hits = parseClickButtons(dv, held.plain ??= {});
          for (const b of hits) onShift(b === 'plus' ? 1 : -1);
          if (!hits.length) onRaw?.(hex(dv));
        }
        fails = 0;
      } catch (err) {
        onLog(`  could not read it: ${err.message}`);
        // a link whose messages will not open usually started from a handshake that got muddled: start again with fresh keys
        if (session.ready && ++fails >= 3 && retries < 2) {
          retries++; fails = 0;
          onLog('messages are not opening, so starting the handshake again');
          await handshake().catch((e) => onLog(`encrypted handshake failed: ${e.message}`));
        }
      }
    };
    // List what the Click offers, then listen on everything that can notify, so nothing it says is missed.
    const chars = await svc.getCharacteristics().catch(() => []);
    const props = (c) => Object.entries({ read: c.properties.read, write: c.properties.write, writeNoResp: c.properties.writeWithoutResponse, notify: c.properties.notify, indicate: c.properties.indicate }).filter(([, v]) => v).map(([k]) => k).join('+');
    chars.forEach((c) => onLog(`has ${c.uuid.slice(0, 8)}: ${props(c) || 'no properties'}`));
    const names = { [ZWIFT.ASYNC]: 'button', [ZWIFT.SYNC_TX]: 'reply' };
    for (const c of chars) {
      if (!(c.properties.notify || c.properties.indicate)) continue;
      const via = names[c.uuid] ?? `char ${c.uuid.slice(0, 8)}`;
      c.addEventListener('characteristicvaluechanged', (e) => handle(via)(e.target.value));
      try { await c.startNotifications(); onLog(`listening on ${via}`); } catch (err) { onLog(`could not listen on ${via}: ${err.message}`); }
    }
    const rx = await svc.getCharacteristic(ZWIFT.SYNC_RX);
    const write = async (bytes, how) => {
      if (how === 'response') return (rx.writeValueWithResponse ?? rx.writeValue).call(rx, bytes);
      return (rx.writeValueWithoutResponse ?? rx.writeValue).call(rx, bytes);
    };
    const waitFor = async (ms, until) => { const end = performance.now() + ms; while (performance.now() < end && !until()) await new Promise((r) => setTimeout(r, 100)); };
    // 1. the encrypted handshake (a long write, so with a response)
    const handshake = async () => {
      session = new ZapSession();
      await write(await session.start(), 'response');
      onLog('sent the encrypted handshake');
    };
    try {
      await handshake();
      await waitFor(6000, () => session.ready || frames > 0); // some Clicks take a few seconds to answer
    } catch (err) { onLog(`encrypted handshake failed: ${err.message}`); }
    // 2. only if it has said nothing at all: the plain greeting, the way the original Click is started
    if (!session.ready && !frames) {
      for (const how of ['without response', 'response']) {
        try { await write(ZWIFT.RIDE_ON, how === 'response' ? 'response' : 'none'); onLog(`sent RideOn (${how})`); } catch (err) { onLog(`RideOn ${how} failed: ${err.message}`); continue; }
        await waitFor(1500, () => frames > 0);
        if (frames) break;
      }
    }
    onLog(session.ready ? 'ready' : frames ? 'now press a button' : 'it has not answered. Press a button on the Click to see if it sends anything.');
    setTimeout(() => { if (!frames && !link.closed) onLog('still nothing heard. Is another device (Zwift, the Companion app, a phone) connected to the Click? Only one can be.'); }, 8000);
  }, onStatus);
  await link.open();
  return link;
}

// ---- Latest-value store --------------------------------------------------------

/** Holds the latest reading per metric and treats stale readings as missing. */
export class DataHub {
  constructor(maxAgeMs = 4000) {
    this.maxAge = maxAgeMs;
    this.vals = {};
    this.ts = {};
  }

  push(fields) {
    const now = performance.now();
    for (const [k, v] of Object.entries(fields)) {
      if (v != null && Number.isFinite(v)) { this.vals[k] = v; this.ts[k] = now; }
    }
  }

  get(key) {
    const age = performance.now() - (this.ts[key] ?? -Infinity);
    return age <= this.maxAge ? this.vals[key] : null;
  }

  snapshot() {
    return { power: this.get('power'), cadence: this.get('cadence'), hr: this.get('hr') };
  }
}
