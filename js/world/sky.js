// Sky, sun, ambient light, fog, clouds, balloons and birds. Time of day follows the course:
// bright morning on the climb, golden hour along the lake.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeCloud } from './textures.js';
import { smoothstep as sm, lerp, hash1 } from './noise.js';

const TAU = Math.PI * 2;
const col = (h) => new THREE.Color(h);

const DAY = {
  sun: col('#fff1dc'), sunI: 3.4, hemiSky: col('#a9ccf5'), hemiGround: col('#59663f'), hemiI: 0.75,
  fog: col('#bcd6ee'), zenith: col('#3f78c2'), horizon: col('#bcd6ee'), cloud: col('#ffffff'), cloudShade: col('#aebfd6'),
  turbidity: 3.2, rayleigh: 1.05, mie: 0.004, mieG: 0.8, exposure: 0.62, bloom: 0.22,
};
const GOLD = {
  sun: col('#ff9a4a'), sunI: 2.9, hemiSky: col('#f4a77a'), hemiGround: col('#4a3624'), hemiI: 0.6,
  fog: col('#f0b690'), zenith: col('#4a5f9a'), horizon: col('#f6b58a'), cloud: col('#ffd2a8'), cloudShade: col('#a56a78'),
  turbidity: 8.5, rayleigh: 2.4, mie: 0.004, mieG: 0.8, exposure: 0.5, bloom: 0.3,
};

export class SkySystem {
  constructor(scene, renderer, { shadowMap = 2048 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    scene.add(this.sky);
    this.envSky = new Sky();
    this.envSky.scale.setScalar(40000);
    this.envScene = new THREE.Scene();
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;
    this.lastEnvElev = -99;

    this.sun = new THREE.DirectionalLight('#fff1dc', 3);
    this.sun.castShadow = shadowMap > 0;
    if (shadowMap > 0) {
      this.sun.shadow.mapSize.set(shadowMap, shadowMap);
      const c = this.sun.shadow.camera;
      c.near = 10; c.far = 700; c.left = -90; c.right = 90; c.top = 90; c.bottom = -90;
      this.sun.shadow.bias = -0.00035;
      this.sun.shadow.normalBias = 0.35;
    }
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight('#a9ccf5', '#59663f', 0.75);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2('#bcd6ee', 0.00042);

    this.dir = new THREE.Vector3(0.3, 0.6, 0.3).normalize();
    this.state = { gold: 0, exposure: 0.62, bloom: 0.22, fog: DAY.fog.clone(), zenith: DAY.zenith.clone(), horizon: DAY.horizon.clone(), cloud: DAY.cloud.clone(), cloudShade: DAY.cloudShade.clone(), sunColor: DAY.sun.clone() };
    this.#buildClouds();
  }

  #buildClouds() {
    const count = 70;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const off = new Float32Array(count * 3), size = new Float32Array(count * 2), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = hash1(i * 3.7) * TAU, r = 800 + hash1(i * 9.1) * 6500;
      off[i * 3] = 800 + Math.cos(a) * r; off[i * 3 + 1] = 950 + hash1(i * 5.3) * 700; off[i * 3 + 2] = -1300 + Math.sin(a) * r;
      const w = 900 + hash1(i * 2.1) * 1400;
      size[i * 2] = w; size[i * 2 + 1] = w * (0.38 + hash1(i * 6.6) * 0.2);
      seed[i] = hash1(i * 1.3);
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 2));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = count;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: makeCloud() }, uColor: { value: new THREE.Color('#fff') }, uShade: { value: new THREE.Color('#aab') }, uTime: { value: 0 }, uWrap: { value: new THREE.Vector2(0, 0) } },
      vertexShader: /* glsl */`
        attribute vec3 aOffset; attribute vec2 aSize; attribute float aSeed;
        uniform float uTime; uniform vec2 uWrap;
        varying vec2 vUv; varying float vSeed; varying float vDist;
        void main() {
          vUv = uv; vSeed = aSeed;
          vec3 c = aOffset;
          float span = 15000.0;
          c.x = mod(c.x + uTime * (3.0 + aSeed * 4.0) - uWrap.x + span * 0.5, span) - span * 0.5 + uWrap.x;
          c.z = mod(c.z - uWrap.y + span * 0.5, span) - span * 0.5 + uWrap.y;
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += (position.xy) * aSize;
          vDist = length(c - cameraPosition);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap; uniform vec3 uColor; uniform vec3 uShade;
        varying vec2 vUv; varying float vSeed; varying float vDist;
        void main() {
          vec4 t = texture2D(uMap, vUv);
          vec3 c = mix(uShade, uColor, smoothstep(0.15, 0.85, vUv.y + (vSeed - 0.5) * 0.2));
          float fade = smoothstep(9000.0, 3500.0, vDist) * smoothstep(300.0, 1400.0, vDist);
          gl_FragColor = vec4(c, t.a * 0.85 * fade);
        }`,
      transparent: true, depthWrite: false, fog: false,
    });
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    this.scene.add(this.clouds);
  }

  /** progress: 0..1 around the loop. */
  setProgress(progress, followPos) {
    const c = 0.5 + 0.5 * Math.cos(TAU * (progress - 0.28)); // 1 = high sun on the climb, 0 = low over the lake
    const elev = lerp(7, 52, c) * (Math.PI / 180);
    const az = (205 + 70 * Math.sin(TAU * progress)) * (Math.PI / 180);
    this.dir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
    const t = sm(0.12, 0.62, c); // 0 = golden, 1 = day
    const gold = 1 - t;
    const L = (k) => DAY[k] instanceof THREE.Color ? DAY[k].clone().lerp(GOLD[k], gold) : lerp(DAY[k], GOLD[k], gold);
    const st = this.state;
    st.gold = gold;
    st.sunColor.copy(L('sun'));
    st.fog.copy(L('fog'));
    st.zenith.copy(L('zenith'));
    st.horizon.copy(L('horizon'));
    st.cloud.copy(L('cloud'));
    st.cloudShade.copy(L('cloudShade'));
    st.exposure = L('exposure');
    st.bloom = L('bloom');

    this.sun.color.copy(st.sunColor);
    this.sun.intensity = L('sunI');
    this.hemi.color.copy(L('hemiSky'));
    this.hemi.groundColor.copy(L('hemiGround'));
    this.hemi.intensity = L('hemiI');
    this.scene.fog.color.copy(st.fog);
    this.scene.fog.density = lerp(0.00040, 0.00056, gold);
    this.cloudMat.uniforms.uColor.value.copy(st.cloud);
    this.cloudMat.uniforms.uShade.value.copy(st.cloudShade);

    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.turbidity.value = L('turbidity');
      u.rayleigh.value = L('rayleigh');
      u.mieCoefficient.value = L('mie');
      u.mieDirectionalG.value = L('mieG');
      u.sunPosition.value.copy(this.dir);
    }
    if (followPos) this.follow(followPos);

    // refresh the reflection environment when the sun has moved a bit
    const e = this.dir.y;
    if (Math.abs(e - this.lastEnvElev) > 0.025) {
      this.lastEnvElev = e;
      this.envTarget?.dispose();
      this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 100000);
      this.scene.environment = this.envTarget.texture;
      this.scene.environmentIntensity = lerp(0.9, 0.55, gold);
    }
  }

  /** Keep the shadow box and sky centred on the camera focus. */
  follow(p) {
    this.sky.position.set(p.x, 0, p.z);
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.dir, 380);
    this.cloudMat.uniforms.uWrap.value.set(p.x, p.z);
  }

  update(time) {
    this.cloudMat.uniforms.uTime.value = time;
  }
}

// ---- hot-air balloons -------------------------------------------------------------------------------------

export function buildBalloons() {
  const group = new THREE.Group();
  const palettes = [['#e63946', '#ffd166'], ['#3fa9f5', '#ffffff'], ['#2ec4b6', '#f472b6']];
  const textures = palettes.map(([a, b]) => {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 16;
    const x = cv.getContext('2d');
    for (let i = 0; i < 12; i++) { x.fillStyle = i % 2 ? b : a; x.fillRect((i * 256) / 12, 0, 256 / 12 + 1, 16); }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  });
  const profile = [];
  for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI; profile.push(new THREE.Vector2(Math.sin(a) * (1 - 0.18 * Math.cos(a) ** 3) * 11, -Math.cos(a) * 13 + 13)); }
  const envelope = new THREE.LatheGeometry(profile, 24);
  const basketGeo = new THREE.BoxGeometry(2.2, 1.6, 2.2);
  palettes.forEach((_, i) => {
    const b = new THREE.Group();
    const env = new THREE.Mesh(envelope, new THREE.MeshStandardMaterial({ map: textures[i], roughness: 0.8, side: THREE.DoubleSide }));
    env.position.y = 7;
    const basket = new THREE.Mesh(basketGeo, new THREE.MeshStandardMaterial({ color: '#7a5230', roughness: 0.9 }));
    basket.position.y = 0;
    b.add(env, basket);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 8, 4), new THREE.MeshBasicMaterial({ color: '#2a1d12' }));
      rope.position.set(x * 0.9, 4.2, z * 0.9);
      rope.rotation.set(z * 0.1, 0, -x * 0.1);
      b.add(rope);
    }
    b.scale.setScalar(2.2);
    b.userData = { cx: 700 + i * 380, cz: -1500 + i * 420, r: 380 + i * 90, alt: 330 + i * 70, speed: 0.012 + i * 0.004, phase: i * 2.1 };
    group.add(b);
  });
  group.userData.update = (t) => {
    group.children.forEach((b) => {
      const u = b.userData;
      const a = t * u.speed + u.phase;
      b.position.set(u.cx + Math.cos(a) * u.r, u.alt + Math.sin(t * 0.3 + u.phase) * 4, u.cz + Math.sin(a) * u.r);
      b.rotation.y = a * 0.3;
    });
  };
  return group;
}

// ---- birds -------------------------------------------------------------------------------------------------

export function buildBirds() {
  const g = new THREE.BufferGeometry();
  // a simple gull: body and two wings, wings flap by scaling y of the instance matrix
  const v = new Float32Array([
    0, 0, 0.5, -0.1, 0, 0.0, 0.1, 0, 0.0, // body
    0, 0, 0.1, -1.1, 0.05, -0.15, 0, 0, -0.25, // left wing
    0, 0, 0.1, 1.1, 0.05, -0.15, 0, 0, -0.25, // right wing
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  const count = 14;
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: '#202833', side: THREE.DoubleSide, fog: true }), count);
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  mesh.userData.update = (t, center) => {
    for (let i = 0; i < count; i++) {
      const flock = i % 2, k = Math.floor(i / 2);
      const a = t * (0.05 + flock * 0.02) + flock * 3 + k * 0.12;
      const r = 220 + flock * 160 + (k % 3) * 18;
      p.set(center.x + Math.cos(a) * r, center.y + 70 + flock * 40 + Math.sin(t * 0.7 + k) * 6, center.z + Math.sin(a) * r);
      q.setFromAxisAngle(up, -a + Math.PI);
      const flap = 0.25 + Math.abs(Math.sin(t * 7 + i)) * 0.9;
      s.set(2.2, flap * 1.4, 2.2);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  return mesh;
}
