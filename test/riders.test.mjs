// Rider rig checks. Canvas drawing is stubbed so the model can be built in plain Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const three = pathToFileURL(path.join(root, 'vendor/three/three.module.min.js')).href;
const addons = pathToFileURL(path.join(root, 'vendor/three/addons/')).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(s, c, n) {
  if (s === 'three') return { url: '${three}', shortCircuit: true };
  if (s.startsWith('three/addons/')) return { url: '${addons}' + s.slice('three/addons/'.length), shortCircuit: true };
  return n(s, c);
}`));

const ctx = new Proxy({}, { get: (_, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

const THREE = await import('three');
const { RiderModel, SKINS, HAIRS } = await import('../js/world/riders.js');

const looks = ['pony', 'short', 'bun'].map((hairStyle, i) => ({ jersey: ['#e63946', '#2ec4b6', '#9b5de5'][i], pattern: ['hoops', 'chevron', 'dots'][i], hairStyle, skin: SKINS[i], hair: HAIRS[i], number: String(10 + i) }));

test('every rider builds light: a couple of dozen meshes and a few thousand triangles', () => {
  for (const look of looks) {
    const m = new RiderModel(look);
    let meshes = 0, tris = 0;
    m.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    });
    assert.ok(meshes >= 15 && meshes <= 34, `${meshes} meshes`);
    assert.ok(tris < 9000, `${Math.round(tris)} triangles`);
  }
});

test('the pedalling rig stays finite, keeps feet on the pedals and bends knees forward', () => {
  const m = new RiderModel({ ...looks[0], isUser: true });
  for (const stand of [0, 1]) {
    for (let k = 0; k < 120; k++) {
      m.update(k * 0.21, k * 0.9, stand, 1 / 60);
      m.group.updateMatrixWorld(true);
      for (let i = 0; i < 2; i++) {
        const pedal = m.tmp.pedal[i], knee = m.tmp.knee[i], hip = m.tmp.hip[i], ankle = m.tmp.ankle[i];
        for (const v of [pedal, knee, hip, ankle, m.tmp.elbow[i]]) assert.ok(Number.isFinite(v.x + v.y + v.z), 'finite joint');
        // the shoe sits on its pedal
        const shoe = m.leg[i].shoe.position;
        assert.ok(Math.hypot(shoe.x - pedal.x, shoe.z - pedal.z) < 1e-6);
        // the knee is ahead of the hip-ankle line
        const mid = hip.clone().add(ankle).multiplyScalar(0.5);
        assert.ok(knee.x > mid.x - 1e-3, 'knee bends forward');
        // legs are never stretched beyond their length
        assert.ok(hip.distanceTo(knee) < 0.5 && knee.distanceTo(ankle) < 0.5);
      }
    }
  }
});

test('standing raises the hips and the rider rocks the bike', () => {
  const m = new RiderModel(looks[1]);
  m.update(0, 0, 0, 1 / 60);
  const seated = m.tmp.hipC.y;
  for (let k = 0; k < 120; k++) m.update(k * 0.2, 0, 1, 1 / 60);
  assert.ok(m.tmp.hipC.y > seated + 0.1, 'hips rise');
  assert.ok(m.standing > 0.95);
});

test('far riders drop their fine details', () => {
  const m = new RiderModel(looks[2]);
  m.setLOD(10);
  assert.ok(m.fine.every((o) => o.visible));
  m.setLOD(100);
  assert.ok(m.fine.every((o) => !o.visible));
  m.setLOD(10);
  assert.ok(m.fine.every((o) => o.visible));
  void THREE;
});
