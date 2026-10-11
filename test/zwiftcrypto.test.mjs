// The encrypted Zwift controller link: AES-CCM against the standard's own test vectors, and a whole handshake against a
// stand-in controller built from the same published scheme.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ccmEncrypt, ccmDecrypt, ZapSession, deriveKeys, clickButtonsFrom, RIDE_ON, RESPONSE_START } from '../js/zwiftcrypto.js';
import { parseClickButtons } from '../js/ble.js';

const hex = (s) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');

// NIST SP 800-38C, appendix C
const K = hex('404142434445464748494a4b4c4d4e4f');
const VECTORS = [
  { nonce: '10111213141516', aad: '0001020304050607', plain: '20212223', tag: 4, out: '7162015b4dac255d' },
  { nonce: '1011121314151617', aad: '000102030405060708090a0b0c0d0e0f', plain: '202122232425262728292a2b2c2d2e2f', tag: 6, out: 'd2a1f0e051ea5f62081a7792073d593d1fc64fbfaccd' },
  { nonce: '101112131415161718191a1b', aad: '000102030405060708090a0b0c0d0e0f10111213', plain: '202122232425262728292a2b2c2d2e2f3031323334353637', tag: 8, out: 'e3b201a9f5b71a7a9b1ceaeccd97e70b6176aad9a4428aa5484392fbc1b09951' },
];

test('AES-CCM matches the standard\'s test vectors, both ways', async () => {
  for (const v of VECTORS) {
    const opts = { aad: hex(v.aad), tagLen: v.tag };
    const enc = await ccmEncrypt(K, hex(v.nonce), hex(v.plain), opts);
    assert.equal(toHex(enc), v.out, `encrypt, nonce ${v.nonce.length / 2} bytes`);
    assert.equal(toHex(await ccmDecrypt(K, hex(v.nonce), hex(v.out), opts)), v.plain, 'decrypt');
  }
});

test('AES-CCM as the Zwift link uses it (8-byte nonce, 4-byte tag, no associated data) round-trips and rejects tampering', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const msg = hex('37 08 00 10 01');
  const sealed = await ccmEncrypt(key, nonce, msg);
  assert.equal(sealed.length, msg.length + 4);
  assert.deepEqual(await ccmDecrypt(key, nonce, sealed), msg);
  const bad = sealed.slice(); bad[2] ^= 1;
  await assert.rejects(() => ccmDecrypt(key, nonce, bad), /authentication/);
  await assert.rejects(() => ccmDecrypt(key, crypto.getRandomValues(new Uint8Array(8)), sealed), /authentication/);
});

/** A stand-in for the controller: answers the handshake, derives the same keys, and sends encrypted button messages. */
async function fakeController() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)).slice(1);
  return {
    pub,
    reply: Uint8Array.of(...RIDE_ON, ...RESPONSE_START, ...pub),
    async keys(handshake, recipe = {}) {
      const theirPub = handshake.slice(8);
      // by default the controller's own key goes first in the salt, then the app's
      return deriveKeys(pair.privateKey, theirPub, false, pub, recipe);
    },
  };
}

test('handshake: the app\'s request has the documented layout and a controller\'s reply gives both sides the same keys', async () => {
  const app = new ZapSession();
  const request = await app.start();
  assert.equal(request.length, 6 + 2 + 64);
  assert.deepEqual([...request.slice(0, 8)], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x00, 0x09]);

  const dev = await fakeController();
  assert.ok(ZapSession.isReply(dev.reply));
  await app.accept(dev.reply);
  const theirs = await dev.keys(request);
  // the controller seals a message with its keys; the app must be able to open it
  const sealed = Uint8Array.of(7, 0, 0, 0, ...(await ccmEncrypt(theirs.key, Uint8Array.of(...theirs.iv, 7, 0, 0, 0), hex('37 08 00 10 01'))));
  assert.deepEqual([...(await app.decrypt(sealed))], [0x37, 8, 0, 0x10, 1]);
  assert.match(app.recipe.name, /theirs-first, key-iv, nonce iv\+counter$/, 'the published recipe is found first');
  assert.equal(theirs.key.length, 32);
  assert.equal(theirs.iv.length, 4);
});

test('a Click\'s encrypted button messages decrypt to presses (+ and −), and the plain bytes still read the old way', async () => {
  const app = new ZapSession();
  const request = await app.start();
  const dev = await fakeController();
  await app.accept(dev.reply);
  const { key, iv } = await dev.keys(request);

  const send = async (counter, plain) => {
    const c = Uint8Array.of(counter & 0xff, (counter >> 8) & 0xff, 0, 0);
    return Uint8Array.of(...c, ...(await ccmEncrypt(key, Uint8Array.of(...iv, ...c), plain)));
  };
  const idle = await app.decrypt(await send(0, hex('37 08 01 10 01')));
  assert.deepEqual(clickButtonsFrom(idle), { plus: false, minus: false });
  assert.deepEqual(clickButtonsFrom(await app.decrypt(await send(1, hex('37 08 00 10 01')))), { plus: true, minus: false });
  assert.deepEqual(clickButtonsFrom(await app.decrypt(await send(2, hex('37 08 01 10 00')))), { plus: false, minus: true });
  assert.deepEqual(clickButtonsFrom(await app.decrypt(await send(1174, hex('37 08 00 10 00')))), { plus: true, minus: true });
  assert.equal(clickButtonsFrom(await app.decrypt(await send(3, hex('19 08 5a')))), null, 'a battery message is not a button press');
  // a message that has been altered is refused rather than misread
  const tampered = await send(4, hex('37 08 00 10 01')); tampered[6] ^= 0x40;
  await assert.rejects(() => app.decrypt(tampered), /authentication/);
  // and the unencrypted form the older Click sends is read by the same rules
  assert.deepEqual(parseClickButtons(new DataView(hex('37 08 00 10 01').buffer), {}), ['plus']);
});

test('if the controller uses a different (plausible) recipe than the published one, the session finds it and sticks with it', async () => {
  for (const [salt, layout, form] of [['ours-first', 'key-iv', 'iv+counter'], ['theirs-first', 'iv-key', 'iv+counter reversed'], ['none', 'key-iv', 'counter+iv']]) {
    const app = new ZapSession();
    const request = await app.start();
    const dev = await fakeController();
    await app.accept(dev.reply);
    // the app derives from its side; the controller from its own: both must give the same pair
    const { key, iv } = await dev.keys(request, { salt: salt === 'theirs-first' ? 'ours-first' : salt === 'ours-first' ? 'theirs-first' : salt, layout });
    const counter = Uint8Array.of(0x8d, 0, 0, 0);
    const nonce = { 'iv+counter': () => Uint8Array.of(...iv, ...counter), 'iv+counter reversed': () => Uint8Array.of(...iv, 0, 0, 0, 0x8d), 'counter+iv': () => Uint8Array.of(...counter, ...iv) }[form]();
    const sealed = Uint8Array.of(...counter, ...(await ccmEncrypt(key, nonce, hex('37 08 01 10 00'))));
    const plain = await app.decrypt(sealed);
    assert.deepEqual(clickButtonsFrom(plain), { plus: false, minus: true }, `${salt} / ${layout} / ${form}`);
    assert.ok(app.recipe.name.includes(form));
  }
});
