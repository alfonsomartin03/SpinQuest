// Cartoon shading shared by the whole world: a stepped light ramp (so every surface reads as a few bold tones instead of a
// smooth PBR gradient) and a helper that swaps the standard materials of anything built elsewhere for toon ones.
// Toon materials are also cheaper to draw than PBR ones and need no reflection environment.

import * as THREE from 'three';

let _ramp = null;

/** The light ramp: shadow, a soft mid tone, and full light, with hard steps between them. */
export function toonRamp() {
  if (_ramp) return _ramp;
  // x runs from facing away from the light (left) to facing it (right)
  const tones = [0.0, 0.0, 0.0, 0.34, 0.34, 0.7, 0.7, 1.0, 1.0, 1.0];
  const data = new Uint8Array(tones.length * 4);
  tones.forEach((v, i) => { const b = Math.round(v * 255); data.set([b, b, b, 255], i * 4); });
  _ramp = new THREE.DataTexture(data, tones.length, 1, THREE.RGBAFormat);
  _ramp.minFilter = _ramp.magFilter = THREE.NearestFilter;
  _ramp.generateMipmaps = false;
  _ramp.needsUpdate = true;
  return _ramp;
}

/** A toon material. Takes the usual material options (color, map, vertexColors, side, ...). */
export function toon(opts = {}) {
  return new THREE.MeshToonMaterial({ gradientMap: toonRamp(), ...opts });
}

const cache = new Map();
const KEEP = ['color', 'map', 'vertexColors', 'side', 'transparent', 'opacity', 'alphaTest', 'depthWrite', 'depthTest', 'polygonOffset', 'polygonOffsetFactor',
  'polygonOffsetUnits', 'emissive', 'emissiveIntensity', 'fog', 'visible'];

/** The toon equivalent of a standard or physical material (the same one every time for the same source). */
export function toToonMaterial(m) {
  if (!m || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return m;
  let t = cache.get(m.uuid);
  if (!t) {
    const o = {};
    for (const k of KEEP) if (m[k] !== undefined) o[k] = m[k] && m[k].isColor ? m[k].clone() : m[k];
    t = toon(o);
    if (m.onBeforeCompile && m.onBeforeCompile.toString() !== THREE.Material.prototype.onBeforeCompile.toString()) t.onBeforeCompile = m.onBeforeCompile;
    t.name = m.name;
    cache.set(m.uuid, t);
  }
  return t;
}

/** Swap every standard material under `root` for a toon one. */
export function cartoonize(root) {
  root.traverse((o) => {
    if (!o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(toToonMaterial) : toToonMaterial(o.material);
  });
  return root;
}
