// Rendering helpers that keep the world cheap to draw: terrain tiling and the cartoon material swap.
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

const THREE = await import('three');
const { tileTerrain } = await import('../js/world/terrain.js');
const { toToonMaterial, cartoonize } = await import('../js/world/toon.js');

function grid(n, cell) {
  const pos = new Float32Array(n * n * 3);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) pos.set([x * cell, Math.sin(x) * 3, z * cell], (z * n + x) * 3);
  const idx = [];
  for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) { const a = z * n + x; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

test('terrain tiles cover every triangle once and each tile bounds its own vertices', () => {
  const g = grid(60, 10);
  const tiles = tileTerrain(g, 150);
  assert.ok(tiles.length > 4, 'split into several tiles');
  assert.equal(tiles.reduce((n, t) => n + t.index.count, 0), g.index.count, 'no triangle lost or doubled');
  for (const t of tiles) {
    assert.equal(t.attributes.position, g.attributes.position, 'vertex data is shared, not copied');
    const p = t.attributes.position, s = t.boundingSphere, v = new THREE.Vector3();
    for (const i of t.index.array) assert.ok(v.fromBufferAttribute(p, i).distanceTo(s.center) <= s.radius + 1e-3, 'vertex inside its tile sphere');
    assert.ok(s.radius < 150, 'a tile sphere is small enough to be culled on its own');
  }
});

test('standard materials become toon ones, once, and keep their look', () => {
  const std = new THREE.MeshStandardMaterial({ color: '#ff8800', vertexColors: true, side: THREE.DoubleSide, alphaTest: 0.5 });
  const t = toToonMaterial(std);
  assert.ok(t.isMeshToonMaterial && t.gradientMap);
  assert.equal(t.vertexColors, true);
  assert.equal(t.side, THREE.DoubleSide);
  assert.equal(t.alphaTest, 0.5);
  assert.equal(toToonMaterial(std), t, 'the same source gives the same toon material');
  const basic = new THREE.MeshBasicMaterial();
  assert.equal(toToonMaterial(basic), basic, 'unlit and shader materials are left alone');
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), std), new THREE.Mesh(new THREE.BoxGeometry(), basic));
  cartoonize(root);
  assert.ok(root.children[0].material.isMeshToonMaterial);
  assert.equal(root.children[1].material, basic);
});
