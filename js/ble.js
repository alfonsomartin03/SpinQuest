// Web Bluetooth: smart trainers / power meters (FTMS, Cycling Power) and heart rate straps.
// Read-only: we never write to the trainer, so the user stays in control of resistance.

export const UUID = {
  FTMS: 0x1826,
  INDOOR_BIKE_DATA: 0x2ad2,
  CPS: 0x1818,
  CP_MEASUREMENT: 0x2a63,
  HRS: 0x180d,
  HR_MEASUREMENT: 0x2a37,
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

// ---- Connections -------------------------------------------------------------

export const bluetoothSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** Why Bluetooth can't be used here, in plain words (or null if it can). */
export function bluetoothProblem() {
  if (bluetoothSupported()) return null;
  if (location.protocol === 'file:') return 'Open the app with "python3 serve.py" (http://localhost:8000), not by double-clicking index.html.';
  if (!window.isSecureContext) return `Bluetooth needs http://localhost:8000 (or https). This page is on ${location.origin}.`;
  return 'This browser has no Web Bluetooth. Use Google Chrome or Microsoft Edge (Safari, Firefox and the Claude app browser do not support it).';
}

/** Turn a Web Bluetooth error into advice the rider can act on. */
export function explainError(err) {
  const msg = err?.message || String(err);
  if (err?.name === 'NotFoundError') {
    return /cancel/i.test(msg) || /chooser/i.test(msg)
      ? 'No device chosen. Wake the device (spin the cranks), then try again.'
      : 'No device found. Wake it by pedalling, tick "Show all Bluetooth devices", and close other apps (Zwift, phone apps) that may hold its connection.';
  }
  if (err?.name === 'SecurityError') return 'Bluetooth blocked. Allow Bluetooth for your browser in system settings and try again.';
  if (err?.name === 'NetworkError') return 'Found it but could not connect. Pedal to wake it, make sure no other app has taken its connection, then retry.';
  if (/No supported power service/.test(msg)) return 'That device has no power or trainer service. Pick your trainer/power meter, not another device.';
  return `Couldn't connect: ${msg}`;
}

async function request(serviceIds, all) {
  const optionalServices = [UUID.FTMS, UUID.CPS, UUID.HRS];
  return navigator.bluetooth.requestDevice(
    all ? { acceptAllDevices: true, optionalServices } : { filters: serviceIds.map((s) => ({ services: [s] })), optionalServices },
  );
}

/**
 * A device link that survives drops: it re-subscribes after reconnecting.
 * `subscribe(server, emit)` must start the notifications.
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
    if (this.device.gatt.connected) this.device.gatt.disconnect();
    this.onStatus('idle', '');
  }
}

async function notify(service, charId, handler) {
  const ch = await service.getCharacteristic(charId);
  ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value));
  await ch.startNotifications();
}

/** Connect a smart trainer or power meter. `emit` receives partial {power, cadence, speed, hr}. */
export async function connectTrainer(emit, onStatus, { all = false } = {}) {
  const device = await request([UUID.FTMS, UUID.CPS], all);
  const cpState = {};
  const link = new Link(device, async (server) => {
    let ftmsPower = false;
    let ftmsPackets = 0;
    let cpsStarted = false;
    const startCps = async () => {
      if (cpsStarted) return;
      cpsStarted = true;
      try {
        const cps = await server.getPrimaryService(UUID.CPS);
        await notify(cps, UUID.CP_MEASUREMENT, (dv) => emit(parseCyclingPower(dv, cpState)));
      } catch { /* no power service */ }
    };
    try {
      const ftms = await server.getPrimaryService(UUID.FTMS);
      await notify(ftms, UUID.INDOOR_BIKE_DATA, (dv) => {
        const d = parseIndoorBikeData(dv);
        ftmsPackets++;
        if (d.power != null) ftmsPower = true;
        if (ftmsPackets === 4 && !ftmsPower) startCps(); // FTMS without power: fall back to CPS
        emit(d);
      });
      return;
    } catch { /* no FTMS */ }
    await startCps();
    if (!cpsStarted) throw new Error('No supported power service on this device');
  }, onStatus);
  await link.open();
  return link;
}

/** Connect a heart rate strap/watch broadcasting the standard Heart Rate service. */
export async function connectHeartRate(emit, onStatus, { all = false } = {}) {
  const device = await request([UUID.HRS], all);
  const link = new Link(device, async (server) => {
    const svc = await server.getPrimaryService(UUID.HRS);
    await notify(svc, UUID.HR_MEASUREMENT, (dv) => emit(parseHeartRate(dv)));
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
