// The 3D renderer: builds the world once, then each frame places the riders on the road, drives the
// chase camera, the time-of-day lighting and the post-processing from the live game state.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { LOOP, TUNNEL, curvatureAt } from '../course.js';
import { POWER_ZONES, HR_ZONES, clamp } from '../physics.js';
import { orbAt, ORB_SPACING } from '../game.js';
import { frame, place, BOUNDS } from './geo.js';
import { TerrainField, buildTerrainMesh, makeDetailTexture } from './terrain.js';
import { buildRoad } from './road.js';
import { buildTunnel, buildBridge } from './structures.js';
import { buildLake, buildRiver, makeWaterUniforms } from './water.js';
import { SkySystem, buildBalloons, buildBirds } from './sky.js';
import { buildFlora } from './flora.js';
import { buildLandmarks, landmarkPads } from './landmarks.js';
import { RiderModel, makeNameTag, SKINS, HAIRS } from './riders.js';
import { OrbField, Particles, AmbientParticles, FinalShader } from './effects.js';

const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

export const QUALITY = {
  low: { dpr: 1, shadow: 0, bloom: false, msaa: 0, draw: 0.55, ambient: 0.3 },
  medium: { dpr: 1.25, shadow: 1024, bloom: false, msaa: 0, draw: 0.8, ambient: 0.6 },
  high: { dpr: 1.5, shadow: 2048, bloom: true, msaa: 4, draw: 1.0, ambient: 1 },
  ultra: { dpr: 1.75, shadow: 3072, bloom: true, msaa: 4, draw: 1.25, ambient: 1 },
};

/** A sensible default for this machine: strong GPUs get High, integrated ones Medium, software rendering Low. */
function detectQuality(gl) {
  try {
    const ext = gl.getContext().getExtension('WEBGL_debug_renderer_info');
    const name = ext ? String(gl.getContext().getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    if (/apple (m|gpu)|nvidia|geforce|radeon rx|radeon pro|rtx|arc /i.test(name)) return 'high';
    if (/intel|mali|adreno|powervr|uhd|iris/i.test(name)) return /iris xe|arc/i.test(name) ? 'high' : 'medium';
  } catch { /* fall through */ }
  return 'medium';
}

// each rider gets their own kit, bike colours, skin tone and hair so the bunch looks like a real group
const BOT_LOOKS = [
  { pattern: 'chevron', accent: '#ffffff', accent2: '#ffe45e', frame: '#2a2d36', wheel: '#1d1f26', helmet: '#f4f4f0', helmetStripe: '#ffb703', hairStyle: 'pony', number: '12' },
  { pattern: 'sash', accent: '#ffffff', accent2: '#ff9f1c', frame: '#1f3a3a', wheel: '#0f1f1f', helmet: '#1b1b1f', helmetStripe: '#2ec4b6', hairStyle: 'short', number: '24' },
  { pattern: 'split', accent: '#2b2b33', accent2: '#ffffff', frame: '#3a2420', wheel: '#241410', helmet: '#f0f0f0', helmetStripe: '#e76f51', hairStyle: 'bun', number: '31' },
  { pattern: 'dots', accent: '#f4f1ea', accent2: '#c8f169', frame: '#2a2140', wheel: '#1a1330', helmet: '#2b2342', helmetStripe: '#c8f169', hairStyle: 'short', number: '45' },
  { pattern: 'fade', accent: '#ffffff', accent2: '#ffffff', frame: '#16313c', wheel: '#0c1b22', helmet: '#e8f7ff', helmetStripe: '#00bbf9', hairStyle: 'pony', number: '58' },
  { pattern: 'bands', accent: '#2b2b33', accent2: '#ffd1e8', frame: '#3b1f31', wheel: '#240f1d', helmet: '#fff0f7', helmetStripe: '#f15bb5', hairStyle: 'short', number: '66' },
];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.62;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.25, 9000);
    this.clock = 0;
    this.quality = (() => { try { return localStorage.getItem('spinquest.quality') || detectQuality(this.gl); } catch { return detectQuality(this.gl); } })();
    if (!QUALITY[this.quality]) this.quality = 'high';
    this.resScale = 1;
    this.frameTimes = [];
    this.pending = [];
    this.userLat = 0;
    this.camLat = 0; this.camH = 1.9; this.camRoll = 0; this.fov = 58;
    this.tunnel = 0;
    this.built = false;
    this.models = new Map();
    this.game = null;
  }

  // ---- building ----------------------------------------------------------------------------------------

  /** Build the whole world. `onProgress(0..1, label)` drives the loading screen. */
  async build(onProgress = () => {}) {
    const q = QUALITY[this.quality];
    const aniso = Math.min(8, this.gl.capabilities.getMaxAnisotropy());
    const step = async (p, label) => { onProgress(p, label); await new Promise((r) => setTimeout(r, 0)); };

    await step(0.02, 'Surveying the course');
    this.field = new TerrainField();
    this.field.buildGrids();
    this.field.setPads(landmarkPads());

    await step(0.06, 'Shaping the land');
    const detail = makeDetailTexture(this.field.noise);
    const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 });
    const inner = { x0: BOUNDS.minX - 800, z0: BOUNDS.minZ - 800, x1: BOUNDS.maxX + 800, z1: BOUNDS.maxZ + 800 };
    const innerGeo = await buildTerrainMesh(this.field, { ...inner, cell: 10, onProgress: (f) => onProgress(0.06 + f * 0.34, 'Shaping the land') });
    this.terrain = new THREE.Mesh(innerGeo, terrainMat);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = false;
    this.scene.add(this.terrain);
    await step(0.42, 'Raising the mountains');
    const outerGeo = await buildTerrainMesh(this.field, { x0: -7000, z0: -9000, x1: 9000, z1: 7000, cell: 48, sinkInside: inner });
    const outer = new THREE.Mesh(outerGeo, new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.97, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
    this.scene.add(outer);

    await step(0.55, 'Paving the road');
    this.scene.add(buildRoad({ anisotropy: aniso }));
    this.scene.add(buildTunnel({ anisotropy: aniso }));
    this.scene.add(buildBridge({ anisotropy: aniso }));

    await step(0.6, 'Filling the lake');
    this.water = makeWaterUniforms();
    this.scene.add(buildLake(this.water), buildRiver(this.water));

    await step(0.64, 'Planting forests');
    this.flora = await buildFlora(this.field, { density: 1, grassDensity: 1, onProgress: (f) => onProgress(0.64 + f * 0.26, 'Planting forests') });
    this.scene.add(this.flora.group);

    await step(0.92, 'Raising landmarks');
    this.landmarks = buildLandmarks(this.field);
    this.scene.add(this.landmarks);

    await step(0.95, 'Lighting the sky');
    this.sky = new SkySystem(this.scene, this.gl, { shadowMap: Math.max(2048, q.shadow || 0) });
    this.balloons = buildBalloons();
    this.birds = buildBirds();
    this.scene.add(this.balloons, this.birds);
    this.snow = new AmbientParticles({ count: 1400, box: 44, fall: 2.2, drift: 0.9, color: '#ffffff', size: 1.15, alpha: 0.85 });
    this.dust = new AmbientParticles({ count: 500, box: 50, fall: 0.25, drift: 0.7, color: '#ffd9a0', size: 0.9, alpha: 0.5, rise: true });
    this.scene.add(this.snow.mesh, this.dust.mesh);

    this.orbs = new OrbField();
    this.particles = new Particles(1600);
    this.scene.add(this.orbs.group, this.particles.points);

    // user marker and zone aura
    const ringGeo = new THREE.RingGeometry(0.85, 1.55, 40);
    ringGeo.rotateX(-Math.PI / 2); // lies flat in the rider's local road plane
    this.aura = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }));
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.4, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b6b').multiplyScalar(2), toneMapped: false }));
    this.marker.rotation.x = Math.PI;
    this.scene.add(this.aura, this.marker);

    this.tunnelLight = new THREE.PointLight('#ffd9a0', 0, 34, 1.6);
    this.scene.add(this.tunnelLight);

    this.#setupPost();
    this.applyQuality(this.quality);
    this.resize();
    this.built = true;
    await step(1, 'Ready');
  }

  #setupPost() {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: QUALITY[this.quality].msaa });
    this.composer = new EffectComposer(this.gl, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.25, 0.65, 0.9);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
  }

  // ---- quality & size ---------------------------------------------------------------------------------------------

  applyQuality(name) {
    if (!QUALITY[name]) return;
    this.quality = name;
    try { localStorage.setItem('spinquest.quality', name); } catch { /* private mode */ }
    const q = QUALITY[name];
    this.gl.shadowMap.enabled = q.shadow > 0;
    if (this.sky) {
      this.sky.sun.castShadow = q.shadow > 0;
      if (q.shadow > 0 && this.sky.sun.shadow.mapSize.x !== q.shadow) {
        this.sky.sun.shadow.mapSize.set(q.shadow, q.shadow);
        this.sky.sun.shadow.map?.dispose();
        this.sky.sun.shadow.map = null;
      }
    }
    this.scene.traverse((o) => { if (o.material) { for (const m of [].concat(o.material)) m.needsUpdate = true; } });
    if (this.composer) this.composer.renderTarget1.samples = this.composer.renderTarget2.samples = q.msaa;
    this.resScale = 1;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.w = w; this.h = h;
    const q = QUALITY[this.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr) * this.resScale;
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      this.final.uniforms.uAspect.value = w / h;
    }
  }

  /** Adaptive resolution: trade a little sharpness for a steady frame rate. */
  #adapt(dt) {
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 100) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    let s = this.resScale;
    if (avg > 0.026 && s > 0.55) s -= 0.1;
    else if (avg < 0.0135 && s < 1) s += 0.1;
    s = Math.min(1, Math.max(0.55, s));
    if (s !== this.resScale) { this.resScale = s; this.resize(); }
  }

  /** Orb pickups. */
  handleEvents(events) {
    for (const e of events) if (e.type === 'orb') this.pending.push(e);
  }

  // ---- riders ------------------------------------------------------------------------------------------------------------

  #bind(game) {
    for (const m of this.models.values()) this.scene.remove(m.model.group);
    this.models.clear();
    this.game = game;
  }

  /** The look for a rider: yours, the bunch's, the coach's, or a generated one for a remote player. */
  #lookFor(r) {
    if (r.kind === 'you') return { jersey: '#ff3b6b', accent: '#ffffff', accent2: '#ffd166', pattern: 'hoops', frame: '#f2f3f7', wheel: '#ff3b6b', helmet: '#ffffff', helmetStripe: '#ff3b6b', skin: SKINS[1], hair: HAIRS[1], hairStyle: 'short', number: 'SQ', isUser: true };
    if (r.kind === 'coach') return { jersey: '#ffd400', accent: '#16181d', accent2: '#ffffff', pattern: 'chevron', frame: '#111318', wheel: '#111318', helmet: '#16181d', helmetStripe: '#ffd400', skin: SKINS[3], hair: HAIRS[4], hairStyle: 'short', number: '★' };
    if (r.kind === 'bot') { const i = r.i ?? 0; return { ...BOT_LOOKS[i % BOT_LOOKS.length], jersey: r.color, skin: SKINS[(i * 2 + 1) % SKINS.length], hair: HAIRS[(i * 3 + 2) % HAIRS.length] }; }
    // remote: stable pseudo-random choices from their id, in the colour they picked
    let h = 7;
    for (const ch of r.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const base = BOT_LOOKS[h % BOT_LOOKS.length];
    return { ...base, jersey: r.color, skin: SKINS[h % SKINS.length], hair: HAIRS[(h >> 3) % HAIRS.length], hairStyle: ['pony', 'short', 'bun'][(h >> 5) % 3], number: String(10 + (h % 90)) };
  }

  #addRider(r) {
    const model = new RiderModel(this.#lookFor(r));
    let label = null;
    if (r.kind !== 'you') { label = makeNameTag(r.name, r.kind === 'coach' ? '#ffd400' : '#ffffff'); label.position.set(0, 2.05, 0); model.group.add(label); }
    model.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.scene.add(model.group);
    this.models.set(r, { model, label, stand: 0 });
  }

  /** Riders can join and leave (remote players), so keep the models in step with the game's list. */
  #syncRiders(game) {
    const live = new Set(game.allRiders());
    for (const [r, entry] of this.models) {
      if (!live.has(r)) { this.scene.remove(entry.model.group); this.models.delete(r); }
    }
    for (const r of live) if (!this.models.has(r)) this.#addRider(r);
  }

  #placeRider(r, entry, game, dt) {
    const f = frame(r.x);
    const lat = r.isUser ? r.lat : r.lat + Math.sin(game.clock * 0.35 + (r.i ?? 7)) * 0.25;
    const fwd = new THREE.Vector3(f.tx, f.grade, f.tz).normalize();
    let up = new THREE.Vector3(0, 1, 0);
    up.sub(fwd.clone().multiplyScalar(up.dot(fwd))).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up);
    const m = new THREE.Matrix4().makeBasis(fwd, up, right);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const lean = clamp(Math.atan((r.v * r.v * curvatureAt(r.x)) / 9.81) * 0.7, -0.4, 0.4);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lean));
    const g = entry.model.group;
    g.position.set(f.x + f.rx * lat, f.y, f.z + f.rz * lat);
    g.quaternion.copy(q);
    const ratio = r.isUser ? game.pSmooth / game.profile.ftp : (r.power || 0) / game.profile.ftp;
    const stand = ratio > 1.35 ? 1 : ratio > 1.15 ? (ratio - 1.15) / 0.2 : 0;
    entry.model.update(r.crank, r.wheel, game.paused && r.isUser ? 0 : stand, dt, 0);
    return f;
  }

  // ---- the frame ----------------------------------------------------------------------------------------------------------

  draw(game, dt) {
    if (!this.built) return;
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const t = this.clock;
    if (this.game !== game) this.#bind(game);
    this.#syncRiders(game);
    const user = game.user;
    this.#adapt(dt);

    // steer toward the next orb for a natural line
    let want = 0;
    const i0 = Math.floor(user.x / ORB_SPACING);
    for (let i = i0; i < i0 + 5; i++) {
      const o = orbAt(i);
      if (o && !game.collected.has(i) && o.x > user.x) { want = o.lat; break; }
    }
    this.userLat += (want - this.userLat) * (1 - Math.exp(-dt * 2.5));
    user.lat = this.userLat;

    // riders
    for (const [r, entry] of this.models) {
      this.#placeRider(r, entry, game, dt);
      if (entry.label) {
        const d = entry.model.group.position.distanceTo(this.camera.position);
        entry.model.setLOD(d);
        entry.label.material.opacity = clamp((70 - d) / 30, 0, 1) * clamp((d - 4) / 4, 0, 1);
        entry.label.visible = entry.label.material.opacity > 0.02;
      }
    }
    const um = this.models.get(user).model.group;

    // chase camera, defined in road space so it follows bends exactly
    const lag = 1 - Math.exp(-dt * 6);
    this.camLat += (user.lat * 0.55 - this.camLat) * lag;
    const speed = user.v;
    const sprint = clamp(game.pSmooth / game.profile.ftp - 1.2, 0, 1);
    const targetH = 2.0 + sprint * 0.1;
    this.camH += (targetH - this.camH) * lag;
    const back = 5.4 + clamp(speed * 0.04, 0, 0.8);
    const camPos = place(user.x - back, this.camLat, this.camH);
    const look = place(user.x + 5, user.lat * 0.3, 0.55);
    this.camera.position.set(camPos.x, camPos.y, camPos.z);
    const shake = clamp(sprint * 0.012 + speed * 0.0006, 0, 0.02);
    this.camera.position.x += Math.sin(t * 31) * shake; this.camera.position.y += Math.sin(t * 27 + 1) * shake;
    this.camera.lookAt(look.x, look.y, look.z);
    const bendLean = clamp(curvatureAt(user.x) * speed * 4.2, -0.12, 0.12);
    this.camRoll += (bendLean - this.camRoll) * lag;
    this.camera.rotateZ(-this.camRoll);
    const fovT = 58 + clamp(speed * 0.5, 0, 14) + sprint * 3;
    this.fov += (fovT - this.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(this.camera.fov - this.fov) > 0.02) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }

    // sun, sky, fog: time of day follows the course
    const ph = wrap(user.x);
    this.sky.setProgress(ph / LOOP, um.position);
    this.sky.update(t);
    const st = this.sky.state;
    const inT = ph > TUNNEL.start - 2 && ph < TUNNEL.end + 2 ? 1 : 0;
    this.tunnel += (inT - this.tunnel) * (1 - Math.exp(-dt * 7));
    const k = 1 - this.tunnel * 0.94;
    this.sky.sun.intensity *= k;
    this.sky.hemi.intensity *= 1 - this.tunnel * 0.82;
    this.scene.environmentIntensity *= 1 - this.tunnel * 0.92;
    this.tunnelLight.intensity = this.tunnel * 55;
    this.tunnelLight.position.set(this.camera.position.x, this.camera.position.y + 2.4, this.camera.position.z).lerp(new THREE.Vector3(um.position.x, um.position.y + 3.4, um.position.z), 0.5);
    this.gl.toneMappingExposure = st.exposure * (1 + this.tunnel * 0.35);

    // water
    const w = this.water;
    w.uTime.value = t;
    w.uSunDir.value.copy(this.sky.dir);
    w.uSunColor.value.copy(st.sunColor);
    w.uSkyHorizon.value.copy(st.horizon);
    w.uSkyZenith.value.copy(st.zenith);

    // the living world
    this.flora.update(this.camera.position, t, QUALITY[this.quality].draw);
    this.landmarks.userData.update(t, this.camera.position);
    this.balloons.userData.update(t);
    this.birds.userData.update(t, um.position);

    // orbs, bursts, sprint sparks
    this.orbs.update(t, user.x, game.collected);
    for (const e of this.pending) {
      const o = orbAt(Math.floor(e.x / ORB_SPACING));
      const p = place(e.x, o ? o.lat : 0, e.h + 0.3);
      this.particles.burst(p.x, p.y, p.z, e.gold ? [3.2, 2.2, 0.6] : [0.5, 1.4, 2.6], e.gold ? 46 : 22, e.gold ? 5.5 : 4, 0.3, 0.9);
    }
    this.pending.length = 0;
    const ratio = game.pSmooth / game.profile.ftp;
    if (ratio > 1.3 && !game.paused) {
      const f = frame(user.x - 0.55);
      const c = ratio > 1.8 ? [2.6, 0.7, 3.2] : [3.0, 1.5, 0.4];
      for (let i = 0; i < 3; i++) this.particles.spawn(f.x + f.rx * user.lat, f.y + 0.12, f.z + f.rz * user.lat, -f.tx * 3 + (Math.random() - 0.5) * 2.5, 1 + Math.random() * 2.5, -f.tz * 3 + (Math.random() - 0.5) * 2.5, c, 0.1 + Math.random() * 0.12, 0.45, 9);
    }
    this.particles.update(dt, this.h);

    // aura under the user and the marker above
    const zone = POWER_ZONES[game.pz];
    const zc = new THREE.Color(zone.color).multiplyScalar(1.6);
    this.aura.material.color.copy(zc.multiplyScalar(0.55));
    this.aura.material.opacity = 0.3 + clamp(ratio, 0, 1.4) * 0.2;
    const pulse = 1 + Math.sin(t * 4) * 0.04 + clamp(ratio - 1, 0, 1) * 0.25;
    this.aura.position.set(um.position.x, um.position.y + 0.07, um.position.z);
    this.aura.quaternion.copy(um.quaternion);
    this.aura.scale.setScalar(pulse);
    this.marker.position.set(um.position.x, um.position.y + 2.25 + Math.sin(t * 3) * 0.06, um.position.z);
    this.marker.rotation.y = t * 2;

    // ambient particles
    const q = QUALITY[this.quality];
    this.snow.update(t, this.camera.position, clamp((this.#snowAt(ph)) * q.ambient, 0, 1), this.h);
    this.dust.update(t, this.camera.position, st.gold * 0.8 * q.ambient, this.h);

    // post-processing uniforms
    const fu = this.final.uniforms;
    fu.uTime.value = t;
    fu.uSpeed.value = clamp((speed - 8) / 16, 0, 1) * 0.9;
    fu.uGold.value = st.gold;
    fu.uTunnel.value = this.tunnel;
    if (game.hr != null && game.hz >= 0) {
      const beat = ((game.clock * game.hr) / 60) % 1;
      fu.uPulse.value = Math.exp(-beat * 6);
      fu.uHrAmt.value = 0.28 + game.hz * 0.2;
      fu.uHrColor.value.set(HR_ZONES[game.hz].color);
    } else { fu.uHrAmt.value = 0; fu.uPulse.value = 0; }
    this.bloom.strength = st.bloom * (this.tunnel ? 1.2 : 1);
    this.bloom.enabled = q.bloom;

    this.composer.render(dt);
  }

  #snowAt(ph) {
    // snow falls on the high pass
    const a = Math.max(0, Math.min(1, (ph - 3700) / 300)) * Math.max(0, Math.min(1, (5300 - ph) / 300));
    return a * 0.9;
  }
}
