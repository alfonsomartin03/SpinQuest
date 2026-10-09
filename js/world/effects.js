// Effects: collectable orbs, particle bursts and sprint sparks, falling snow and dust motes, and the
// post-processing shader (speed blur, heart-rate glow, golden-hour grade).

import * as THREE from 'three';
import { orbAt, ORB_SPACING } from '../game.js';
import { place } from './geo.js';
import { hash1 } from './noise.js';

// ---- orbs -------------------------------------------------------------------------------------------------

export class OrbField {
  constructor() {
    this.max = 90;
    const geo = new THREE.IcosahedronGeometry(0.2, 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), this.max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.halo = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.07, depthWrite: false, toneMapped: false }), this.max);
    this.halo.frustumCulled = false;
    this.halo.count = 0;
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.halo);
    this.blue = new THREE.Color(0.3, 1.05, 2.0);
    this.gold = new THREE.Color(2.6, 1.8, 0.4);
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = {};
  }

  /** Lay out the orbs between the rider and ~250 m ahead. */
  update(t, userX, collected) {
    const i0 = Math.floor((userX - 6) / ORB_SPACING);
    const i1 = i0 + Math.ceil(260 / ORB_SPACING);
    let n = 0;
    const q = this.q, s = new THREE.Vector3(), pos = new THREE.Vector3();
    for (let i = i0; i <= i1 && n < this.max; i++) {
      const o = orbAt(i);
      if (!o || collected.has(i)) continue;
      place(o.x, o.lat, o.h + 0.25 + Math.sin(t * 2.4 + i) * 0.06, this.p);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 1.8 + i);
      const sc = o.gold ? 1.35 : 1;
      pos.set(this.p.x, this.p.y, this.p.z);
      this.m.compose(pos, q, s.set(sc, sc, sc));
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, o.gold ? this.gold : this.blue);
      this.m.compose(pos, q, s.set(sc * (1 + 0.1 * Math.sin(t * 5 + i)), sc, sc));
      this.halo.setMatrixAt(n, this.m);
      this.halo.setColorAt(n, o.gold ? this.gold : this.blue);
      n++;
    }
    this.mesh.count = n; this.halo.count = n;
    this.mesh.instanceMatrix.needsUpdate = true; this.halo.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true;
  }
}

// ---- burst particles --------------------------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */`
  attribute float aSize; attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAG = /* glsl */`
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vColor.rgb, vColor.a * a * a);
  }
`;

export class Particles {
  constructor(max = 1400) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.next = 0;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uScale = { value: 800 };
    this.points = new THREE.Points(this.geo, new THREE.ShaderMaterial({
      uniforms: { uScale: this.uScale }, vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
  }

  spawn(x, y, z, vx, vy, vz, rgb, size, life, grav = 9) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3);
    this.col.set([rgb[0], rgb[1], rgb[2], 1], i * 4);
    this.size[i] = size; this.life[i] = this.maxLife[i] = life; this.grav[i] = grav;
  }

  burst(x, y, z, rgb, n, speed = 4, size = 0.28, life = 0.8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), sp = speed * (0.3 + Math.random());
      this.spawn(x, y, z, Math.sin(b) * Math.cos(a) * sp, Math.cos(b) * sp + 1.5, Math.sin(b) * Math.sin(a) * sp, rgb, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6));
    }
  }

  update(dt, viewHeight) {
    this.uScale.value = viewHeight * 0.9;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; continue; }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 4 + 3] = k;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}
// ---- ambient particles: snow and dust motes, animated entirely on the GPU ---------------------------------------

export class AmbientParticles {
  constructor({ count = 1200, box = 46, fall = 1.6, drift = 0.6, color = '#ffffff', size = 1.1, alpha = 0.8, rise = false } = {}) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) { pos[i * 3] = hash1(i * 1.7) * box; pos[i * 3 + 1] = hash1(i * 2.9) * box; pos[i * 3 + 2] = hash1(i * 4.3) * box; seed[i] = hash1(i * 7.1); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmount: { value: 1 }, uScale: { value: 800 }, uColor: { value: new THREE.Color(color) } };
    this.mesh = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime; uniform vec3 uCam; uniform float uScale; uniform float uAmount;
        varying float vA;
        void main() {
          float box = ${box.toFixed(1)};
          vec3 p = position;
          float dir = ${rise ? '1.0' : '-1.0'};
          p.y += dir * uTime * ${fall.toFixed(2)} * (0.6 + aSeed * 0.8);
          p.x += sin(uTime * 0.6 + aSeed * 30.0) * ${drift.toFixed(2)} + uTime * ${(drift * 0.8).toFixed(2)};
          p.z += cos(uTime * 0.5 + aSeed * 20.0) * ${drift.toFixed(2)};
          vec3 w = mod(p - uCam + box * 0.5, box) - box * 0.5 + uCam;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float fade = smoothstep(box * 0.5, box * 0.25, length(w - uCam));
          vA = fade * step(aSeed, uAmount);
          gl_PointSize = ${size.toFixed(2)} * (0.6 + aSeed) * uScale / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA;
        void main() { vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(c)); gl_FragColor = vec4(uColor, a * vA * ${alpha.toFixed(2)}); }`,
      transparent: true, depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
  }

  update(t, cam, amount, viewHeight) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(cam);
    this.uniforms.uAmount.value = amount;
    this.uniforms.uScale.value = viewHeight * 0.6;
    this.mesh.visible = amount > 0.01;
  }
}

// ---- post-processing shader --------------------------------------------------------------------------------------

export const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uSpeed: { value: 0 }, uPulse: { value: 0 }, uHrColor: { value: new THREE.Color('#ff4d4d') },
    uHrAmt: { value: 0 }, uGold: { value: 0 }, uAspect: { value: 1 }, uTunnel: { value: 0 }, uFlash: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uSpeed; uniform float uPulse; uniform vec3 uHrColor;
    uniform float uHrAmt; uniform float uGold; uniform float uAspect; uniform float uTunnel; uniform float uFlash;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      c.x *= uAspect;
      float r = length(c);
      vec2 dir = (vUv - 0.5);
      // radial speed blur, stronger toward the edges and leaving the centre sharp
      float blur = uSpeed * smoothstep(0.12, 0.75, r) * 0.05;
      vec3 col = vec3(0.0);
      const int N = 7;
      for (int i = 0; i < N; i++) {
        float k = float(i) / float(N - 1);
        vec2 uv = vUv - dir * blur * k;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float ca = uSpeed * 0.0035 * smoothstep(0.1, 0.8, r);
        s.r = texture2D(tDiffuse, uv - dir * ca).r;
        s.b = texture2D(tDiffuse, uv + dir * ca).b;
        col += s;
      }
      col /= float(N);
      // vignette
      float vig = smoothstep(0.95, 0.28, r);
      col *= mix(0.62, 1.0, vig) * mix(1.0, 0.55, uTunnel * smoothstep(0.2, 0.9, r));
      // heart-rate glow pulsing with each beat
      col += uHrColor * uHrAmt * (0.12 + 0.55 * uPulse) * smoothstep(0.32, 0.95, r);
      // golden-hour grade
      col *= mix(vec3(1.0), vec3(1.06, 0.97, 0.86), uGold);
      col += vec3(0.04, 0.03, 0.0) * uGold * smoothstep(0.1, 0.0, abs(vUv.y - 0.5));
      col += uFlash * vec3(1.0, 0.95, 0.8) * 0.35;
      // fine grain breaks up banding in the sky
      col += (hash(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5) * 0.012;
      gl_FragColor = vec4(col, 1.0);
    }`,
};
