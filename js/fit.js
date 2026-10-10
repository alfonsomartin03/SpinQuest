// A minimal FIT (Flexible and Interoperable Data Transfer) file writer. No DOM, no dependencies.
// Fields are declared as [number, type] pairs; a missing value (null/NaN) is written as that type's "invalid" marker.

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
export const FIT_EPOCH = 631065600;
export const toFitTime = (ms) => Math.floor(ms / 1000) - FIT_EPOCH;

const TYPES = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  sint16: { id: 0x83, size: 2, invalid: 0x7fff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  sint32: { id: 0x85, size: 4, invalid: 0x7fffffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
};

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

/** The CRC-16 FIT files carry in their header and trailer. */
export function crc16(bytes, crc = 0) {
  for (const byte of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

export class FitWriter {
  constructor() {
    this.bytes = [];
    this.defs = new Map(); // local message number -> field list
  }

  #int(v, size) {
    for (let i = 0; i < size; i++) this.bytes.push(Math.floor(v / 2 ** (8 * i)) & 0xff); // two's complement for negatives
  }

  /** Declare the layout of a message; data() calls with the same local number then follow it. */
  define(local, globalNum, fields) {
    this.defs.set(local, fields);
    this.bytes.push(0x40 | local, 0, 0); // definition header, reserved, little-endian
    this.#int(globalNum, 2);
    this.bytes.push(fields.length);
    for (const [num, type] of fields) this.bytes.push(num, TYPES[type].size, TYPES[type].id);
  }

  /** Write one message; `values` line up with the fields given to define(). */
  data(local, values) {
    const fields = this.defs.get(local);
    this.bytes.push(local);
    fields.forEach(([, type], i) => {
      const t = TYPES[type];
      const v = values[i];
      this.#int(v == null || Number.isNaN(v) ? t.invalid : Math.round(v), t.size);
    });
  }

  /** Header + messages + CRC as the bytes of a .fit file. */
  finish() {
    const head = [14, 0x20, 0, 0]; // size, protocol 2.0, profile version (filled below)
    const profile = 2132;
    head[2] = profile & 0xff; head[3] = profile >> 8;
    const n = this.bytes.length;
    for (let i = 0; i < 4; i++) head.push((n >>> (8 * i)) & 0xff);
    head.push(0x2e, 0x46, 0x49, 0x54); // ".FIT"
    const hcrc = crc16(head);
    head.push(hcrc & 0xff, hcrc >> 8);
    const out = Uint8Array.from([...head, ...this.bytes, 0, 0]);
    const crc = crc16(out.subarray(0, out.length - 2));
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >> 8;
    return out;
  }
}
