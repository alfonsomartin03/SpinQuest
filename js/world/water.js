// Lake and stream: one shader with animated ripples, fresnel sky reflection, sun glitter and
// a shallow-to-deep colour ramp. No texture files; the ripples are computed in the shader.

import * as THREE from 'three';
import { LAKE, RIVER } from './terrain.js';

const VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkyZenith;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform float uFlow;       // 0 = still lake, 1 = running stream
  uniform float uStorm;
  varying vec3 vWorld;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  // Cartoon water: depth in a few soft bands, thin drifting highlight lines, white foam along the shore.
  void main() {
    vec2 p = vWorld.xz;
    float t = uTime;
    float depth = clamp(vUv.x, 0.0, 1.0);
    float db = depth * 3.0;
    db = (floor(db) + smoothstep(0.3, 0.7, fract(db))) / 3.0;
    vec3 col = mix(uShallow, uDeep, db) * 1.25;
    vec2 q = uFlow > 0.5 ? vec2(vUv.x * 7.0, vUv.y * 1.4 - t * 0.9) : p * 0.2 + vec2(t * 0.07, t * 0.05);
    float n = noise(q) + 0.5 * noise(q * 2.3 - vec2(t * 0.1, -t * 0.08));
    float line = smoothstep(0.07, 0.035, abs(fract(n * 3.2) - 0.5));
    col = mix(col, vec3(1.0), line * 0.32);
    col = mix(col, uSkyHorizon * 1.6, 0.1);
    float foam = 0.0;
    if (uFlow > 0.5) {
      float edge = smoothstep(0.0, 0.16, vUv.x) * smoothstep(1.0, 0.84, vUv.x);
      foam = (1.0 - edge) * (0.55 + 0.45 * noise(vec2(vUv.x * 12.0, vUv.y * 3.0 - t * 2.0)));
    } else {
      foam = (1.0 - smoothstep(0.0, 0.09 + 0.05 * noise(p * 0.5 + t * 0.2), depth)) * 0.95;
    }
    col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0));
    float alpha = uFlow > 0.5 ? 0.9 : mix(0.7, 0.97, depth);
    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
  }
`;

export function makeWaterMaterial(shared, flow = 0) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: shared.uTime, uSunDir: shared.uSunDir, uSunColor: shared.uSunColor, uSkyHorizon: shared.uSkyHorizon, uSkyZenith: shared.uSkyZenith,
      uShallow: { value: new THREE.Color('#2fe0d0') }, uDeep: { value: new THREE.Color('#1580e0') }, uFlow: { value: flow }, uStorm: { value: 0 },
    }]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide, // the lake's triangles wind downward, so it must show from above regardless
  });
}

/** Shared uniform objects so the sky system can drive every water surface at once. */
export function makeWaterUniforms() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2) },
    uSunColor: { value: new THREE.Color('#fff2d8') },
    uSkyHorizon: { value: new THREE.Color('#b6d2ea') },
    uSkyZenith: { value: new THREE.Color('#4f86c6') },
  };
}

export function buildLake(shared) {
  const rings = 14, segs = 72;
  const pos = [], uv = [], idx = [];
  const N = { x: -LAKE.tz, z: LAKE.tx };
  for (let r = 0; r <= rings; r++) {
    const rr = (r / rings) * 1.1;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const la = Math.cos(a) * LAKE.ra * rr, lb = Math.sin(a) * LAKE.rb * rr;
      pos.push(LAKE.cx + LAKE.tx * la + N.x * lb, LAKE.level, LAKE.cz + LAKE.tz * la + N.z * lb);
      // depth ramp: shallow at the shore, deep toward the middle
      uv.push(1 - Math.min(1, Math.max(0, (rr - 0.62) / 0.4)), 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s, b = a + 1, c = a + segs + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, makeWaterMaterial(shared, 0));
  m.renderOrder = 5;
  m.frustumCulled = false;
  return m;
}

export function buildRiver(shared) {
  const pts = RIVER.pts;
  const half = 5.2;
  const pos = [], uv = [], idx = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    if (i) acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    const y = RIVER.level[i];
    const widen = i > pts.length - 14 ? 1 + (i - (pts.length - 14)) * 0.12 : 1; // opens out into the lake
    pos.push(p.x - tz * half * widen, y, p.z + tx * half * widen, p.x + tz * half * widen, y, p.z - tx * half * widen);
    uv.push(0, acc / 10, 1, acc / 10);
  }
  for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const mat = makeWaterMaterial(shared, 1);
  mat.uniforms.uShallow.value.set('#44e8d0');
  mat.uniforms.uDeep.value.set('#1f9ae0');
  const m = new THREE.Mesh(g, mat);
  m.renderOrder = 5;
  m.frustumCulled = false;
  return m;
}
