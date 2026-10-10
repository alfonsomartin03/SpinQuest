// The encrypted link to newer Zwift controllers (Click v2, Play, Ride). The scheme was worked out by the community; this
// follows the open-source ZwiftPlay project (github.com/ajchellew/zwiftplay), written down here in full so it can be tested:
//
//  1. Both sides make a P-256 (secp256r1) key pair. The app writes  "RideOn" 00 09 <its public key: X then Y, 32 bytes each>
//     to the controller; the controller answers  "RideOn" 01 03 <its public key, 64 bytes>.
//  2. Shared secret = ECDH(app private, controller public). Key material = HKDF-SHA256(secret, salt = controller public
//     key followed by app public key, no info) for 36 bytes: the first 32 are an AES-256 key, the last 4 an IV.
//  3. Each message from the controller is  <4-byte counter> <ciphertext> <4-byte tag>  protected with AES-CCM: nonce =
//     IV followed by the 4 counter bytes exactly as received (8 bytes), tag length 4, no associated data.
//  4. Decrypted, the first byte says what the message is (0x37 = a Click's buttons) and the rest is its payload.
//
// Web Crypto has ECDH, HKDF and AES-CTR/CBC but no CCM, so CCM is built here from AES-CTR (the keystream) and AES-CBC (the
// CBC-MAC), as the CCM standard (NIST SP 800-38C / RFC 3610) defines it. It is tested against the standard's own vectors.

const subtle = globalThis.crypto.subtle;

export const RIDE_ON = Uint8Array.of(0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e);
export const REQUEST_START = Uint8Array.of(0x00, 0x09);
export const RESPONSE_START = Uint8Array.of(0x01, 0x03);
export const KEY_BYTES = 64; // an uncompressed P-256 point without its 0x04 prefix
const HKDF_BYTES = 36;
const TAG_BYTES = 4;

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const startsWith = (data, prefix) => prefix.every((b, i) => data[i] === b);

// ---- AES-CCM ----------------------------------------------------------------------------------------------------

/** Encode the CBC-MAC input blocks for CCM: B0, the associated data, then the message, each padded to 16 bytes. */
function macInput(nonce, aad, message, tagLen) {
  const q = 15 - nonce.length; // bytes used for the message length
  const b0 = new Uint8Array(16);
  b0[0] = (aad.length ? 0x40 : 0) | (((tagLen - 2) / 2) << 3) | (q - 1);
  b0.set(nonce, 1);
  let len = message.length;
  for (let i = 15; i > 15 - q; i--) { b0[i] = len & 0xff; len = Math.floor(len / 256); }
  const parts = [b0];
  if (aad.length) {
    if (aad.length >= 0xff00) throw new Error('associated data too long');
    parts.push(concat(Uint8Array.of(aad.length >> 8, aad.length & 0xff), aad));
    const pad = (16 - (parts[1].length % 16)) % 16;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(message);
  const pad = (16 - (message.length % 16)) % 16;
  if (pad) parts.push(new Uint8Array(pad));
  return concat(...parts);
}

/** The CCM counter block A_i: flags (q - 1), the nonce, and i as a q-byte big-endian number. */
function counterBlock(nonce, i) {
  const q = 15 - nonce.length;
  const a = new Uint8Array(16);
  a[0] = q - 1;
  a.set(nonce, 1);
  for (let k = 15, n = i; k > 15 - q; k--) { a[k] = n & 0xff; n = Math.floor(n / 256); }
  return a;
}

async function ccmKeystream(key, nonce, length, startBlock) {
  if (!length) return new Uint8Array(0);
  const k = await subtle.importKey('raw', key, 'AES-CTR', false, ['encrypt']);
  const q = 15 - nonce.length;
  // AES-CTR increments the low `length` bits of the counter block, which is exactly CCM's q-byte counter
  const ks = await subtle.encrypt({ name: 'AES-CTR', counter: counterBlock(nonce, startBlock), length: q * 8 }, k, new Uint8Array(length));
  return new Uint8Array(ks);
}

async function cbcMac(key, input) {
  const k = await subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  // CBC with a zero IV: the MAC is the last block of ciphertext. (Web Crypto adds a padding block after it: ignore that.)
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, input));
  return out.slice(input.length - 16, input.length);
}

/** AES-CCM encrypt: returns ciphertext followed by the tag. */
export async function ccmEncrypt(key, nonce, plaintext, { aad = new Uint8Array(0), tagLen = TAG_BYTES } = {}) {
  const mac = await cbcMac(key, macInput(nonce, aad, plaintext, tagLen));
  const s0 = await ccmKeystream(key, nonce, 16, 0);
  const tag = mac.slice(0, tagLen).map((b, i) => b ^ s0[i]);
  const ks = await ccmKeystream(key, nonce, plaintext.length, 1);
  return concat(plaintext.map((b, i) => b ^ ks[i]), tag);
}

/** AES-CCM decrypt (ciphertext followed by the tag). Throws if the tag does not match. */
export async function ccmDecrypt(key, nonce, data, { aad = new Uint8Array(0), tagLen = TAG_BYTES } = {}) {
  if (data.length < tagLen) throw new Error('message too short');
  const cipher = data.slice(0, data.length - tagLen), tag = data.slice(data.length - tagLen);
  const ks = await ccmKeystream(key, nonce, cipher.length, 1);
  const plain = cipher.map((b, i) => b ^ ks[i]);
  const mac = await cbcMac(key, macInput(nonce, aad, plain, tagLen));
  const s0 = await ccmKeystream(key, nonce, 16, 0);
  let diff = 0;
  for (let i = 0; i < tagLen; i++) diff |= (mac[i] ^ s0[i]) ^ tag[i];
  if (diff) throw new Error('authentication failed');
  return plain;
}

// ---- the session with a controller -----------------------------------------------------------------------------------

/** Derive the key and IV the way the controller does. Exposed so a test can play the controller's part. */
export async function deriveKeys(privateKey, theirPublicRaw64, theirKeyFirst, ourPublicRaw64) {
  const theirs = await subtle.importKey('raw', concat(Uint8Array.of(0x04), theirPublicRaw64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const salt = theirKeyFirst ? concat(theirPublicRaw64, ourPublicRaw64) : concat(ourPublicRaw64, theirPublicRaw64);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array(0) }, hkdfKey, HKDF_BYTES * 8));
  return { key: bits.slice(0, 32), iv: bits.slice(32, 36) };
}

export class ZapSession {
  constructor() {
    this.ready = false;
    this.key = null;
    this.iv = null;
  }

  /** Make our key pair and the message that starts the handshake. */
  async start() {
    this.pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const raw = new Uint8Array(await subtle.exportKey('raw', this.pair.publicKey)); // 04 || X || Y
    this.publicKey = raw.slice(1);
    return concat(RIDE_ON, REQUEST_START, this.publicKey);
  }

  /** Is this the controller's answer to the handshake? */
  static isReply(data) { return data.length >= 8 && startsWith(data, RIDE_ON) && data[6] === RESPONSE_START[0]; }

  /** Take the controller's public key from its reply and work out the shared key. */
  async accept(reply) {
    if (!ZapSession.isReply(reply)) throw new Error('not a handshake reply');
    const theirs = reply.slice(8);
    if (theirs.length < KEY_BYTES) throw new Error(`reply carries ${theirs.length} bytes of key, expected ${KEY_BYTES}`);
    const { key, iv } = await deriveKeys(this.pair.privateKey, theirs.slice(0, KEY_BYTES), true, this.publicKey);
    this.key = key;
    this.iv = iv;
    this.ready = true;
  }

  /** Decrypt one message: <4-byte counter> <ciphertext> <tag>. Returns the plain bytes (first byte = message type). */
  async decrypt(data) {
    if (!this.ready) throw new Error('no key yet');
    if (data.length <= 4 + TAG_BYTES) throw new Error('too short to be an encrypted message');
    const nonce = concat(this.iv, data.slice(0, 4));
    return ccmDecrypt(this.key, nonce, data.slice(4));
  }
}

/** What a message from the Click means once decrypted: the buttons it reports, or null if it is something else. */
export function clickButtonsFrom(plain) {
  if (plain[0] !== 0x37) return null;
  // a protobuf with two varint fields: 1 = the + button, 2 = the − button; a value of 0 means held down
  const out = { plus: false, minus: false };
  let i = 1;
  while (i < plain.length) {
    const tag = plain[i++];
    if (tag === 0) break;
    if ((tag & 7) !== 0) return null; // not a varint
    let v = 0, shift = 0;
    while (i < plain.length) { const b = plain[i++]; v += (b & 0x7f) * 2 ** shift; shift += 7; if (!(b & 0x80)) break; }
    if (tag >> 3 === 1) out.plus = v === 0;
    else if (tag >> 3 === 2) out.minus = v === 0;
  }
  return out;
}
