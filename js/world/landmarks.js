// Landmarks and trackside life: arches and gantries, windmills, a castle, lighthouse, church, cabin,
// market, boats, cows and cheering crowds. Everything is built from primitives.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOOP, JUNCTION, SPUR_LEN, LANDMARKS, SEGMENTS } from '../course.js';
import { frame, place } from './geo.js';
import { LAKE, lakeR } from './terrain.js';
import { makeSign, makeStone, makeRoofTiles, makeWood } from './textures.js';
import { mulberry32, hash1 } from './noise.js';

const C = (h) => new THREE.Color(h);
const mats = new Map();
function mat(color, { rough = 0.8, metal = 0, emissive = null, flat = false } = {}) {
  const k = `${color}|${rough}|${metal}|${emissive}|${flat}`;
  if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive || '#000', emissiveIntensity: emissive ? 1 : 0, flatShading: flat }));
  return mats.get(k);
}
const basic = (color, k = 1) => new THREE.MeshBasicMaterial({ color: C(color).multiplyScalar(k), toneMapped: false });

function add(group, geo, material, x = 0, y = 0, z = 0, { rx = 0, ry = 0, rz = 0, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = shadow; m.receiveShadow = true;
  group.add(m);
  return m;
}
const box = (g, w, h, d, x, y, z, color, o = {}) => add(g, new THREE.BoxGeometry(w, h, d), mat(color, o), x, y, z, o);
const cyl = (g, rt, rb, h, x, y, z, color, seg = 12, o = {}) => add(g, new THREE.CylinderGeometry(rt, rb, h, seg), mat(color, o), x, y, z, o);

/** Landmark footprints to level in the terrain. */
export function landmarkPads() {
  const pads = [];
  for (const lm of LANDMARKS) {
    const p = place(lm.d, lm.lat);
    if (lm.kind === 'castle') pads.push({ x: p.x, z: p.z, r: 38, blend: 40 });
    else if (lm.kind === 'windmill') pads.push({ x: p.x, z: p.z, r: 6, blend: 4 });
    else if (lm.kind === 'cabin') pads.push({ x: p.x, z: p.z, r: 5.5, blend: 4 });
    else if (lm.kind === 'church') pads.push({ x: p.x, z: p.z, r: 7.5, blend: 4 });
    else if (lm.kind === 'lighthouse') pads.push({ x: p.x, z: p.z, r: 6, blend: 8, lift: 0.4 });
  }
  return pads;
}

/** yaw that turns a local +x axis toward the road, for an object `lat` metres off it. */
function faceRoad(f, lat) {
  const s = Math.sign(lat) || 1;
  return Math.atan2(s * f.rz, -s * f.rx);
}

// ---- individual landmarks ---------------------------------------------------------------------------------

function windmill(anim) {
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 2.7, 10, 10), mat('#ece4d0', { flat: true }));
  tower.position.y = 5; tower.castShadow = tower.receiveShadow = true; g.add(tower);
  cyl(g, 2.85, 3.0, 1.6, 0, 0.8, 0, '#8a8479', 10);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.2, 2.6, 10), mat('#8a4a38', { flat: true }));
  cap.position.y = 11.3; cap.castShadow = true; g.add(cap);
  box(g, 1.1, 2.2, 0.15, 2.45, 1.1, 0, '#5a3a24');
  const hub = new THREE.Group();
  hub.position.set(2.0, 10.0, 0);
  g.add(hub);
  add(hub, new THREE.CylinderGeometry(0.4, 0.5, 1.0, 10), mat('#5a3a24'), -0.3, 0, 0, { rz: Math.PI / 2 });
  const sails = new THREE.Group();
  hub.add(sails);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.x = (i * Math.PI) / 2;
    box(arm, 0.18, 8.6, 0.18, 0.35, 4.6, 0, '#5a3a24');
    box(arm, 0.04, 6.2, 1.5, 0.45, 5.4, 0.9, '#f4efe2', { rough: 0.9 });
    for (let k = 0; k < 6; k++) box(arm, 0.05, 0.07, 1.55, 0.47, 2.6 + k * 1.0, 0.9, '#7a5a40');
    sails.add(arm);
  }
  anim.push((t) => { sails.rotation.x = t * 0.55; });
  g.scale.setScalar(1.15);
  return g;
}

function castle() {
  const g = new THREE.Group();
  const stone = makeStone(8, 165);
  stone.repeat.set(0.25, 0.25);
  const wall = new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95, color: '#d9d4c8' });
  const roof = mat('#8e3b36', { rough: 0.7, flat: true });
  const addWall = (w, h, d, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
  const tower = (x, z, r, h) => {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 14), wall);
    t.position.set(x, h / 2 - 3, z); t.castShadow = t.receiveShadow = true; g.add(t);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.22, r * 1.1, 1.2, 14), wall);
    ring.position.set(x, h - 3.4, z); ring.castShadow = true; g.add(ring);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, r * 2.4, 14), roof);
    cone.position.set(x, h - 2.4 + r * 1.2, z); cone.castShadow = true; g.add(cone);
    return cone;
  };
  addWall(34, 3, 34, 0, -1.4, 0); // foundation reaching below the ground
  addWall(30, 13, 24, 0, 7.5, 0);
  for (let i = 0; i < 15; i++) addWall(1.2, 1.4, 24.6, -14 + i * 2, 14.6, 0); // crenellations (along z)
  for (let i = 0; i < 15; i++) { addWall(30.6, 1.4, 1.2, 0, 14.6, -11.5 + i * 1.6); }
  const cones = [tower(-17, -14, 4.4, 30), tower(17, -14, 4.4, 30), tower(-17, 14, 4.4, 26), tower(17, 14, 4.4, 26)];
  addWall(10, 22, 10, 0, 14, -2);
  const keep = new THREE.Mesh(new THREE.ConeGeometry(8.5, 10, 4), roof);
  keep.position.set(0, 30, -2); keep.rotation.y = Math.PI / 4; keep.castShadow = true; g.add(keep);
  // gate and windows face +x (toward the road)
  const dark = mat('#1d1f27');
  const gate = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.4, 16, 1, false, 0, Math.PI), dark);
  gate.rotation.set(Math.PI / 2, 0, Math.PI / 2); gate.position.set(15.1, 6.2, 0); g.add(gate);
  box(g, 0.4, 6.2, 6, 15.1, 3.1, 0, '#1d1f27');
  for (const [y, z] of [[10, -7], [10, 7], [10, 0], [19, -2], [19, 2]]) box(g, 0.3, 2.2, 1.0, 15.1, y, z, '#2b3550', { emissive: null });
  const flagMat = new THREE.MeshStandardMaterial({ color: '#d8333f', side: THREE.DoubleSide, roughness: 0.8 });
  const flags = [];
  for (const c of cones) {
    const y = c.position.y + c.geometry.parameters.height / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 5), mat('#c8c8c8'));
    pole.position.set(c.position.x, y + 2.4, c.position.z); g.add(pole);
    const fg = new THREE.PlaneGeometry(3.4, 1.9, 8, 2);
    fg.translate(1.7, 0, 0);
    const fl = new THREE.Mesh(fg, flagMat);
    fl.position.set(c.position.x, y + 4, c.position.z);
    g.add(fl);
    flags.push(fl);
  }
  g.userData.flags = flags;
  g.scale.setScalar(1.25);
  return g;
}

function lighthouse(anim) {
  const g = new THREE.Group();
  const tower = [];
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const h = 3.4;
    const r0 = 3.0 - (i / bands) * 1.1, r1 = 3.0 - ((i + 1) / bands) * 1.1;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, 16), mat(i % 2 ? '#d3322d' : '#f6f4ee', { flat: false }));
    seg.position.y = 1.7 + i * h; seg.castShadow = seg.receiveShadow = true; g.add(seg); tower.push(seg);
  }
  cyl(g, 3.4, 3.5, 3, 0, -0.4, 0, '#8a867c', 16);
  const top = 1.7 + bands * 3.4 - 1.7;
  cyl(g, 2.1, 2.1, 0.5, 0, top + 0.25, 0, '#2b2e36', 18);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 2.0, 14), new THREE.MeshBasicMaterial({ color: C('#ffe9a8').multiplyScalar(2.2), toneMapped: false }));
  lens.position.y = top + 1.5; g.add(lens);
  const frameMat = mat('#2b2e36');
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; box(g, 0.1, 2.1, 0.1, Math.cos(a) * 1.1, top + 1.5, Math.sin(a) * 1.1, '#2b2e36'); }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.6, 14), mat('#d3322d'));
  roof.position.y = top + 3.4; roof.castShadow = true; g.add(roof);
  // the beam: two long soft cones that sweep round
  const beamGeo = new THREE.ConeGeometry(2.6, 90, 14, 1, true);
  beamGeo.rotateZ(-Math.PI / 2);
  beamGeo.translate(45, 0, 0);
  const beamMat = new THREE.MeshBasicMaterial({ color: C('#ffeab0').multiplyScalar(1.4), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const beam = new THREE.Group();
  beam.position.y = top + 1.5;
  for (const s of [1, -1]) { const m = new THREE.Mesh(beamGeo, beamMat); m.scale.x = s; beam.add(m); }
  g.add(beam);
  anim.push((t) => { beam.rotation.y = t * 0.8; });
  g.scale.setScalar(1.1);
  return g;
}

function church() {
  const g = new THREE.Group();
  const wallMat = mat('#efe6d2', { flat: true });
  const roofMat = mat('#8a4034', { flat: true });
  box(g, 14, 6, 8, 0, 3, 0, '#efe6d2');
  const shape = new THREE.Shape();
  shape.moveTo(-4.6, 0); shape.lineTo(0, 3.2); shape.lineTo(4.6, 0); shape.lineTo(-4.6, 0);
  const roofG = new THREE.ExtrudeGeometry(shape, { depth: 14.6, bevelEnabled: false });
  roofG.rotateY(Math.PI / 2); roofG.translate(-7.3, 6, 0);
  add(g, roofG, roofMat);
  box(g, 5, 14, 5, 6.2, 7, 0, '#f2eadb');
  const spire = new THREE.Mesh(new THREE.ConeGeometry(3.7, 8, 4), mat('#5d4a63', { flat: true }));
  spire.position.set(6.2, 18, 0); spire.rotation.y = Math.PI / 4; spire.castShadow = true; g.add(spire);
  box(g, 0.14, 2.2, 0.14, 6.2, 23.2, 0, '#d9b65a', { metal: 0.8, rough: 0.3 });
  box(g, 1.2, 0.14, 0.14, 6.2, 23.4, 0, '#d9b65a', { metal: 0.8, rough: 0.3 });
  // clock faces and windows
  const clock = makeSign('XII', { w: 128, h: 128, bg: '#f7f2e4', fg: '#2b2b2b', border: '#8b7b4a', round: 64, size: 0.3 });
  const face = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), new THREE.MeshBasicMaterial({ map: clock.texture }));
  face.position.set(6.2, 11, 2.55); g.add(face);
  const face2 = face.clone(); face2.position.z = -2.55; face2.rotation.y = Math.PI; g.add(face2);
  const face3 = face.clone(); face3.position.set(8.75, 11, 0); face3.rotation.y = Math.PI / 2; g.add(face3);
  for (const x of [-4, 0, 3.6]) for (const z of [-4.02, 4.02]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.4), new THREE.MeshStandardMaterial({ color: '#7fa4c8', roughness: 0.2, metalness: 0.4 }));
    w.position.set(x, 3.4, z); if (z < 0) w.rotation.y = Math.PI; g.add(w);
  }
  box(g, 0.2, 3.4, 2.4, 8.78, 1.7, 0, '#5e3d28');
  return g;
}

function cabin(anim) {
  const g = new THREE.Group();
  const wood = makeWood(8);
  wood.repeat.set(2, 1);
  const logMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9, color: '#c79a6a' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(7, 3.2, 5.4), logMat);
  body.position.y = 1.6; body.castShadow = body.receiveShadow = true; g.add(body);
  const shape = new THREE.Shape();
  shape.moveTo(-3.1, 0); shape.lineTo(0, 2.1); shape.lineTo(3.1, 0); shape.lineTo(-3.1, 0);
  const rg = new THREE.ExtrudeGeometry(shape, { depth: 7.8, bevelEnabled: false });
  rg.rotateY(Math.PI / 2); rg.translate(-3.9, 3.2, 0);
  add(g, rg, mat('#55372a', { flat: true }));
  box(g, 0.8, 2.6, 0.8, -1.4, 4.4, 1.3, '#7b6a62');
  box(g, 0.2, 2.2, 1.1, 3.55, 1.1, 0, '#4a2f1d');
  box(g, 0.2, 1.1, 1.3, 3.55, 1.9, -1.8, '#f2d28a', { emissive: '#4a3a10' });
  box(g, 0.2, 1.1, 1.3, 3.55, 1.9, 1.8, '#f2d28a', { emissive: '#4a3a10' });
  box(g, 2.2, 0.15, 5.2, 4.7, 0.1, 0, '#8d8a82'); // porch step
  // chimney smoke
  const N = 14;
  const puffs = [];
  for (let i = 0; i < N; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), new THREE.MeshBasicMaterial({ color: '#e6e6ea', transparent: true, opacity: 0.4, depthWrite: false, fog: true }));
    g.add(s); puffs.push(s);
  }
  anim.push((t) => puffs.forEach((p, i) => {
    const k = ((t * 0.18 + i / N) % 1);
    p.position.set(-1.4 + k * 3.2 + Math.sin(t + i) * 0.2, 6 + k * 7, 1.3);
    p.scale.setScalar(0.5 + k * 2.4);
    p.material.opacity = 0.38 * (1 - k);
  }));
  return g;
}

function stall(rng) {
  const g = new THREE.Group();
  const stripes = document.createElement('canvas');
  stripes.width = 64; stripes.height = 8;
  const sc = stripes.getContext('2d');
  const a = ['#d8333f', '#2f7fd0', '#f2b632', '#2fa36b'][Math.floor(rng() * 4)];
  for (let i = 0; i < 8; i++) { sc.fillStyle = i % 2 ? '#f6f2e8' : a; sc.fillRect(i * 8, 0, 8, 8); }
  const tex = new THREE.CanvasTexture(stripes);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  for (const [x, z] of [[-1.6, -1.1], [-1.6, 1.1], [1.6, -1.1], [1.6, 1.1]]) box(g, 0.12, 2.6, 0.12, x, 1.3, z, '#6d4b30');
  box(g, 3.2, 0.9, 1.4, 0, 0.45, 0.7 * 0, '#a07a52');
  const awning = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.08, 2.9), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
  awning.position.set(0, 2.62, 0); awning.rotation.z = 0.12; awning.castShadow = true; g.add(awning);
  const goods = ['#e0423a', '#f2b632', '#6eb04a', '#f08a3a'];
  for (let i = 0; i < 9; i++) add(g, new THREE.SphereGeometry(0.17, 8, 6), mat(goods[Math.floor(rng() * 4)]), -1.3 + (i % 5) * 0.65, 1.07, -0.4 + Math.floor(i / 5) * 0.5);
  return g;
}

function cow(rng) {
  const g = new THREE.Group();
  const white = mat('#f4f1ea', { rough: 0.9 }), black = mat('#222226', { rough: 0.9 }), pink = mat('#e8a5a0', { rough: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 1.2, 4, 10), white);
  body.rotation.z = Math.PI / 2; body.position.y = 1.35; body.castShadow = true; g.add(body);
  for (let i = 0; i < 3; i++) add(g, new THREE.SphereGeometry(0.34, 8, 6), black, -0.5 + i * 0.55, 1.5 + (i % 2) * 0.2, (i % 2 ? 0.45 : -0.45), { shadow: false });
  for (const [x, z] of [[-0.8, -0.3], [-0.8, 0.3], [0.8, -0.3], [0.8, 0.3]]) cyl(g, 0.09, 0.08, 0.95, x, 0.48, z, '#efe9dc', 6);
  const head = new THREE.Group();
  head.position.set(1.45, 1.55, 0);
  add(head, new THREE.BoxGeometry(0.55, 0.45, 0.42), white, 0, 0, 0);
  add(head, new THREE.BoxGeometry(0.2, 0.3, 0.38), pink, 0.35, -0.08, 0);
  add(head, new THREE.ConeGeometry(0.06, 0.2, 5), mat('#efe6cf'), -0.1, 0.3, 0.2);
  add(head, new THREE.ConeGeometry(0.06, 0.2, 5), mat('#efe6cf'), -0.1, 0.3, -0.2);
  g.add(head);
  g.userData.head = head;
  g.userData.phase = rng() * 10;
  return g;
}

function sailboat(rng) {
  const g = new THREE.Group();
  const prof = new THREE.Shape();
  prof.moveTo(-3, 0.55); prof.lineTo(3.3, 0.75); prof.lineTo(2.2, -0.45); prof.lineTo(-2.6, -0.45); prof.lineTo(-3, 0.55);
  const hullG = new THREE.ExtrudeGeometry(prof, { depth: 1.8, bevelEnabled: true, bevelSize: 0.25, bevelThickness: 0.3, bevelSegments: 2 });
  hullG.translate(0, 0, -0.9);
  const hull = new THREE.Mesh(hullG, mat('#f6f6f2'));
  hull.castShadow = true;
  g.add(hull);
  box(g, 6.2, 0.18, 2.5, 0.1, 0.35, 0, rng() > 0.5 ? '#d8333f' : '#2f7fd0');
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 9.5, 6), mat('#9aa0a8'));
  mast.position.set(0.3, 5, 0); g.add(mast);
  const sail = (pts, color) => {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(([x, y]) => s.lineTo(x, y));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.8 }));
    m.castShadow = true; return m;
  };
  g.add(sail([[0.5, 0.7], [0.5, 9], [3.6, 1.0]], '#fbfbf8'));
  g.add(sail([[0.1, 0.8], [0.1, 6.4], [-2.7, 0.9]], rng() > 0.5 ? '#e8473f' : '#3a8fd8'));
  return g;
}

// ---- crowds ---------------------------------------------------------------------------------------------------

const SHIRTS = ['#e63946', '#2f7fd0', '#f2b632', '#2fa36b', '#9b5de5', '#f4f1ea', '#ff7a2f', '#2ec4b6'];

function buildCrowd(spots, field) {
  // spots: [{d0, d1, step, latMin, latMax, count?}]
  const people = [];
  const rng = mulberry32(777);
  for (const s of spots) {
    for (let d = s.d0; d <= s.d1; d += s.step) {
      for (const side of [-1, 1]) {
        if (rng() > (s.p ?? 1)) continue;
        const f = frame(d + (rng() - 0.5) * s.step);
        const lat = (s.latMin + rng() * (s.latMax - s.latMin)) * side;
        const x = f.x + f.rx * lat, z = f.z + f.rz * lat;
        people.push({ x, z, y: field.height(x, z), face: Math.atan2(side * f.rz, -side * f.rx), ph: rng() * 10, shirt: C(SHIRTS[Math.floor(rng() * SHIRTS.length)]), scale: 0.92 + rng() * 0.18, flag: rng() > 0.78 });
      }
    }
  }
  const n = people.length;
  const bodyGeo = new THREE.CapsuleGeometry(0.23, 0.5, 3, 8); bodyGeo.translate(0, 1.15, 0);
  const headGeo = new THREE.SphereGeometry(0.17, 8, 6);
  const legGeo = new THREE.BoxGeometry(0.34, 0.8, 0.22); legGeo.translate(0, 0.4, 0);
  const armGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.62, 5); armGeo.translate(0, 0.31, 0);
  const flagPole = new THREE.CylinderGeometry(0.025, 0.025, 2.2, 4); flagPole.translate(0, 1.1, 0);
  const flagGeo = new THREE.PlaneGeometry(0.9, 0.55); flagGeo.translate(0.45, 0, 0);
  const bodies = new THREE.InstancedMesh(bodyGeo, mat('#ffffff', { rough: 0.85 }), n);
  const heads = new THREE.InstancedMesh(headGeo, mat('#e1b08a', { rough: 0.7 }), n);
  const legs = new THREE.InstancedMesh(legGeo, mat('#2b3140', { rough: 0.9 }), n);
  const arms = new THREE.InstancedMesh(armGeo, mat('#e1b08a', { rough: 0.7 }), n * 2);
  const flagged = people.filter((p) => p.flag);
  const poles = new THREE.InstancedMesh(flagPole, mat('#d4d4d4'), Math.max(1, flagged.length));
  const flags = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.8 }), Math.max(1, flagged.length));
  people.forEach((p, i) => bodies.setColorAt(i, p.shirt));
  flagged.forEach((p, i) => flags.setColorAt(i, C(['#e63946', '#2f7fd0', '#f2b632', '#2fa36b'][i % 4])));
  for (const m of [bodies, heads, legs, arms, poles, flags]) { m.frustumCulled = false; m.castShadow = true; }
  const group = new THREE.Group();
  group.add(bodies, heads, legs, arms, poles, flags);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qa = new THREE.Quaternion(), e = new THREE.Euler();
  const p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), local = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  const cheer = (t, cam, mood) => {
    let fi = 0;
    for (let i = 0; i < n; i++) {
      const p = people[i];
      const near = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < 260 * 260;
      if (!near) { // park out of sight, cheaply
        s3.set(0, 0, 0); p3.set(p.x, p.y, p.z); m4.compose(p3, q.identity(), s3);
        bodies.setMatrixAt(i, m4); heads.setMatrixAt(i, m4); legs.setMatrixAt(i, m4); arms.setMatrixAt(i * 2, m4); arms.setMatrixAt(i * 2 + 1, m4);
        if (p.flag) { poles.setMatrixAt(fi, m4); flags.setMatrixAt(fi, m4); fi++; }
        continue;
      }
      const bounce = Math.abs(Math.sin(t * (4 + mood) + p.ph)) * 0.22 * mood;
      q.setFromAxisAngle(up, p.face);
      s3.setScalar(p.scale);
      p3.set(p.x, p.y + bounce, p.z);
      m4.compose(p3, q, s3);
      bodies.setMatrixAt(i, m4); legs.setMatrixAt(i, m4);
      local.makeTranslation(0, 1.72, 0);
      heads.setMatrixAt(i, tmp.multiplyMatrices(m4, local));
      for (let k = 0; k < 2; k++) {
        const side = k ? -1 : 1;
        const wave = Math.sin(t * 8 + p.ph + k * 2) * 0.5;
        e.set(side * (0.5 + wave * 0.7), 0, side * (2.3 + wave * 0.35));
        qa.setFromEuler(e);
        local.compose(p.flag && k === 0 ? p3.set(0.05, 1.5, side * 0.26) : p3.set(0, 1.5, side * 0.26), qa, s3.set(1, 1, 1));
        arms.setMatrixAt(i * 2 + k, tmp.multiplyMatrices(m4, local));
      }
      if (p.flag) {
        local.makeTranslation(0.1, 1.45, 0.3);
        poles.setMatrixAt(fi, tmp.multiplyMatrices(m4, local));
        local.makeTranslation(0.1, 3.0, 0.3);
        flags.setMatrixAt(fi, tmp.multiplyMatrices(m4, local));
        fi++;
      }
    }
    for (const m of [bodies, heads, legs, arms, poles, flags]) m.instanceMatrix.needsUpdate = true;
  };
  return { group, cheer, count: n };
}

// ---- gantries and signs ------------------------------------------------------------------------------------------

function gantry(text, color, { chequer = false, bunting = true, height = 7.2, width = 6.6 } = {}) {
  const g = new THREE.Group();
  const steel = mat('#dfe3ea', { metal: 0.6, rough: 0.35 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, height, 0.5), steel);
    post.position.set(0, height / 2, s * width); post.castShadow = true; g.add(post);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 1.2), mat('#555a63'));
    foot.position.set(0, 0.2, s * width); g.add(foot);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.7, width * 2 + 0.6), mat(color, { rough: 0.5 }));
  beam.position.set(0, height - 0.6, 0); beam.castShadow = true; g.add(beam);
  const sign = makeSign(text, { w: 1024, h: 170, bg: null, fg: '#ffffff', size: 0.62 });
  for (const s of [1, -1]) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width * 2 - 0.4, 1.35), new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, toneMapped: false }));
    plane.position.set(s * 0.48, height - 0.6, 0);
    plane.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.add(plane);
  }
  if (chequer) {
    const cells = 20;
    for (let c = 0; c < cells; c++) {
      const sq = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, (width * 2 + 0.6) / cells), mat(c % 2 ? '#ffffff' : '#111111'));
      sq.position.set(0, height - 1.5, -width - 0.3 + (c + 0.5) * ((width * 2 + 0.6) / cells));
      g.add(sq);
    }
  }
  if (bunting) {
    const cols = ['#ff5a5f', '#ffd166', '#3fa9f5', '#6ee7b7', '#f472b6', '#ffffff'];
    const tris = [];
    const n = 22;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 0.7) / n;
      const z0 = -width + t0 * width * 2, z1 = -width + t1 * width * 2;
      const sag = (t) => Math.sin(t * Math.PI) * 0.9;
      const y0 = height - 1.6 - sag(t0), y1 = height - 1.6 - sag(t1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0.5, y0, z0, 0.5, y1, z1, 0.5, (y0 + y1) / 2 - 0.55, (z0 + z1) / 2], 3));
      const c = C(cols[i % cols.length]);
      geo.setAttribute('color', new THREE.Float32BufferAttribute([c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b], 3));
      tris.push(geo);
    }
    for (const dx of [0, -1]) {
      const merged = mergeGeometries(tris.map((t) => t.clone().translate(dx, 0, 0)));
      g.add(new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }
  }
  return g;
}

function kmSign(km, label = `${km} km`) {
  const g = new THREE.Group();
  box(g, 0.1, 2.4, 0.1, 0, 1.2, 0, '#9aa0aa', { metal: 0.5 });
  const s = makeSign(label, { w: 256, h: 128, bg: '#fafaf6', fg: '#1b2330', border: '#d8333f', size: 0.5, round: 14 });
  for (const ry of [0, Math.PI]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), new THREE.MeshStandardMaterial({ map: s.texture, roughness: 0.5 }));
    p.position.set(0, 2.2, ry ? -0.07 : 0.07); p.rotation.y = ry; g.add(p);
  }
  return g;
}

// ---- assembly ----------------------------------------------------------------------------------------------------------

export function buildLandmarks(field) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const anim = [];
  const rng = mulberry32(31337);
  const placeObj = (obj, d, lat, { yawFrom = 'road', y = null } = {}) => {
    const f = frame(d);
    const p = place(d, lat);
    const h = y ?? field.height(p.x, p.z);
    obj.position.set(p.x, h, p.z);
    obj.rotation.y = yawFrom === 'road' ? faceRoad(f, lat) : -Math.atan2(f.tz, f.tx);
    group.add(obj);
    return obj;
  };

  for (const lm of LANDMARKS) {
    if (lm.kind === 'windmill') placeObj(windmill(anim), lm.d, lm.lat);
    if (lm.kind === 'castle') {
      const c = placeObj(castle(), lm.d, lm.lat);
      group.userData.castle = c;
    }
    if (lm.kind === 'lighthouse') placeObj(lighthouse(anim), lm.d, lm.lat);
    if (lm.kind === 'church') placeObj(church(), lm.d, lm.lat);
    if (lm.kind === 'cabin') placeObj(cabin(anim), lm.d, lm.lat);
    if (lm.kind === 'arch') {
      const gA = gantry('START · FINISH', '#e6335c', { chequer: true });
      placeObj(gA, lm.d, 0, { yawFrom: 'along' });
      // chequered line on the tarmac
      const f = frame(lm.d);
      const lg = new THREE.PlaneGeometry(1.6, 9.2);
      lg.rotateX(-Math.PI / 2); // lies flat: width along the road (x), length across it (z)
      const line = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ map: chequerTexture(), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      line.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(f.tx, 0, f.tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(f.rx, 0, f.rz)).setPosition(f.x, f.y + 0.05, f.z));
      group.add(line);
    }
    if (lm.kind === 'summit') {
      placeObj(gantry('SUMMIT  1,374 m', '#2f7fd0', { height: 7.8 }), lm.d, 0, { yawFrom: 'along' });
      // a snow-capped marker stone beside the road
      const st = new THREE.Group();
      add(st, new THREE.IcosahedronGeometry(1.6, 1), mat('#8d8f94', { flat: true }), 0, 1.0, 0);
      add(st, new THREE.IcosahedronGeometry(1.2, 1), mat('#f3f6fb', { flat: true }), 0, 2.0, 0);
      placeObj(st, lm.d + 6, 8.2);
    }
    if (lm.kind === 'market') {
      for (let k = -3; k <= 3; k++) {
        placeObj(stall(rng), lm.d + k * 8, -(8.6 + (k % 2) * 0.4));
        placeObj(stall(rng), lm.d + k * 8 + 4, 8.6 + (k % 2) * 0.4);
      }
    }
    if (lm.kind === 'cows') {
      const herd = [];
      for (let i = 0; i < 7; i++) {
        const c = cow(rng);
        const side = i % 2 ? 1 : -1;
        const o = placeObj(c, lm.d + (rng() - 0.5) * 40, side * (14 + rng() * 22), { yawFrom: 'along' });
        o.rotation.y = rng() * Math.PI * 2;
        o.scale.setScalar(0.9 + rng() * 0.2);
        herd.push(c);
      }
      anim.push((t) => herd.forEach((c) => { c.userData.head.rotation.z = -0.35 + Math.sin(t * 0.7 + c.userData.phase) * 0.4; }));
    }
  }
  // sailboats on the lake
  const boats = [];
  for (let i = 0; i < 5; i++) {
    const b = sailboat(rng);
    const a = rng() * Math.PI * 2, r = 0.25 + rng() * 0.45;
    const la = Math.cos(a) * LAKE.ra * r, lb = Math.sin(a) * LAKE.rb * r;
    b.position.set(LAKE.cx + LAKE.tx * la - LAKE.tz * lb, LAKE.level, LAKE.cz + LAKE.tz * la + LAKE.tx * lb);
    b.rotation.y = rng() * 6.28;
    b.userData = { y0: LAKE.level, ph: rng() * 6, yaw: b.rotation.y };
    group.add(b); boats.push(b);
  }
  anim.push((t) => boats.forEach((b) => {
    b.position.y = b.userData.y0 + 0.05 + Math.sin(t * 1.1 + b.userData.ph) * 0.07;
    b.rotation.z = Math.sin(t * 0.9 + b.userData.ph) * 0.05;
    b.rotation.y = b.userData.yaw + Math.sin(t * 0.05 + b.userData.ph) * 0.2;
  }));

  // segment gantries (start and finish)
  for (const s of SEGMENTS) {
    placeObj(gantry(s.name.toUpperCase(), s.color, { bunting: false, height: 6.6, width: 6.2 }), s.start, 0, { yawFrom: 'along' });
    placeObj(gantry('FINISH', s.color, { chequer: true, bunting: false, height: 6.6, width: 6.2 }), s.end, 0, { yawFrom: 'along' });
  }
  // kilometre markers
  for (let k = 1; k < 10; k++) placeObj(kmSign(k), k * 1000, 8.4);
  // the turn point, and the extension's own kilometre markers
  placeObj(gantry('TURN POINT  ·  +10 KM FLAT', '#14a89a', { bunting: false, height: 6.8, width: 7.4 }), JUNCTION - 130, 0, { yawFrom: 'along' });
  for (let k = 1; k < SPUR_LEN / 1000; k++) placeObj(kmSign(k, `+${k} km`), LOOP + k * 1000, 8.4);

  // cheering crowds
  const crowd = buildCrowd([
    { d0: -30, d1: 30, step: 2.6, latMin: 6.4, latMax: 10.5, p: 0.95 },
    { d0: 4560, d1: 4650, step: 2.6, latMin: 6.4, latMax: 10, p: 0.95 },
    { d0: 8480, d1: 8960, step: 6.5, latMin: 6.4, latMax: 10, p: 0.7 },
    { d0: JUNCTION - 190, d1: JUNCTION - 90, step: 5, latMin: 8.5, latMax: 13, p: 0.55 },
    { d0: 2290, d1: 2320, step: 4, latMin: 6.6, latMax: 9, p: 0.6 },
    { d0: 7640, d1: 7660, step: 4, latMin: 6.6, latMax: 9, p: 0.6 },
  ], field);
  group.add(crowd.group);

  group.userData.update = (t, cam) => {
    for (const a of anim) a(t);
    crowd.cheer(t, cam, 1);
    const castleFlags = group.userData.castle?.userData.flags;
    if (castleFlags) for (const fl of castleFlags) {
      const p = fl.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        p.setZ(i, Math.sin(t * 4 + x * 2.2) * 0.22 * (x / 3.4));
      }
      p.needsUpdate = true;
    }
  };
  group.userData.crowd = crowd.count;
  return group;
}

function chequerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 16; j++) { x.fillStyle = (i + j) % 2 ? '#ffffff' : '#101010'; x.fillRect(i * 16, j * 16, 16, 16); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
