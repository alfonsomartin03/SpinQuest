// Procedural textures drawn on canvases at start-up. No image files to load, license or ship.

import * as THREE from 'three';
import { mulberry32 } from './noise.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

const speckle = (ctx, w, h, n, rand, lo, hi, a) => {
  for (let i = 0; i < n; i++) {
    const v = Math.floor(lo + rand() * (hi - lo));
    ctx.fillStyle = `rgba(${v},${v},${v},${a})`;
    const s = rand() < 0.1 ? 2 : 1;
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
};

/**
 * Road surface: clean blue-grey tarmac with bold white lines. One tile covers 11.6 m across (shoulder to shoulder) and 12 m
 * along. Returns {map}. Lateral position u = (lat + 5.8) / 11.6.
 */
export function makeAsphalt(aniso) {
  const W = 256, H = 512;
  const px = W / 11.6; // pixels per metre across
  /** The tarmac, with the lane markings asked for: `edges` the bold edge lines, `dash` the centre dash. */
  const draw = ({ edges, dash }) => {
    const [c, ctx] = canvas(W, H);
    const rand = mulberry32(5);
    ctx.fillStyle = '#566083';
    ctx.fillRect(0, 0, W, H);
    // shoulders are a lighter slate
    ctx.fillStyle = '#6a759c';
    ctx.fillRect(0, 0, (5.8 - 4.55) * px, H);
    ctx.fillRect((5.8 + 4.55) * px, 0, (5.8 - 4.55) * px, H);
    // a fine, soft grain so big flat areas are not dead
    speckle(ctx, W, H, 9000, rand, 40, 120, 0.08);
    // darker bands where the wheels run
    for (const lat of [-2.4, 2.4]) {
      const g = ctx.createLinearGradient((lat + 5.8) * px - 0.9 * px, 0, (lat + 5.8) * px + 0.9 * px, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(10,12,30,0.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect((lat + 5.8) * px - 0.9 * px, 0, 1.8 * px, H);
    }
    // lane markings: bold edge lines and a centre dash (3 m on, 3 m off)
    ctx.fillStyle = '#ffffff';
    if (edges) {
      const edge = 0.22 * px;
      ctx.fillRect((5.8 - 4.35) * px - edge / 2, 0, edge, H);
      ctx.fillRect((5.8 + 4.35) * px - edge / 2, 0, edge, H);
    }
    if (dash) {
      const d = 0.2 * px;
      for (let k = 0; k < 2; k++) ctx.fillRect(5.8 * px - d / 2, k * (H / 2), d, H / 4);
    }
    return tex(c, { aniso });
  };
  // `junction` (centre dash only) is the road where another joins or leaves it, and `plain` (no markings) a road that is
  // still running in or out of another one: an intersection has one set of lines, not two
  return { map: draw({ edges: true, dash: true }), junction: draw({ edges: false, dash: true }), plain: draw({ edges: false, dash: false }) };
}

/** Red and white kerb stripes: one tile is one red block and one white block along the road. */
export function makeKerb() {
  const [c, ctx] = canvas(16, 64);
  ctx.fillStyle = '#ff3a30'; ctx.fillRect(0, 0, 16, 32);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 32, 16, 32);
  const t = tex(c, { aniso: 4 });
  t.magFilter = THREE.NearestFilter;
  return t;
}

export function makeWood(aniso) {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(11);
  const planks = 8;
  for (let i = 0; i < planks; i++) {
    const v = 92 + Math.floor(rand() * 28);
    ctx.fillStyle = `rgb(${v + 20},${v},${v - 30})`;
    ctx.fillRect(0, (i * H) / planks, W, H / planks);
    ctx.strokeStyle = 'rgba(40,24,12,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, (i * H) / planks); ctx.lineTo(W, (i * H) / planks); ctx.stroke();
    ctx.strokeStyle = 'rgba(50,30,15,0.25)'; ctx.lineWidth = 1;
    for (let g = 0; g < 7; g++) {
      ctx.beginPath();
      const y = (i * H) / planks + 4 + rand() * (H / planks - 8);
      ctx.moveTo(0, y); ctx.bezierCurveTo(W * 0.3, y + (rand() - 0.5) * 4, W * 0.6, y + (rand() - 0.5) * 4, W, y);
      ctx.stroke();
    }
  }
  speckle(ctx, W, H, 4000, rand, 20, 90, 0.3);
  return tex(c, { aniso });
}

export function makeStone(aniso, tone = 150) {
  const W = 512, H = 512;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(21);
  ctx.fillStyle = `rgb(${tone - 30},${tone - 32},${tone - 36})`;
  ctx.fillRect(0, 0, W, H);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const h = H / rows;
    let x = -((r % 2) * 40);
    while (x < W) {
      const w = 60 + rand() * 70;
      const v = tone - 20 + Math.floor(rand() * 50);
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 8})`;
      ctx.fillRect(x + 2, r * h + 2, w - 4, h - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x + 2, r * h + 2, w - 4, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x + 2, r * h + h - 7, w - 4, 5);
      x += w;
    }
  }
  speckle(ctx, W, H, 14000, rand, 40, 190, 0.18);
  return tex(c, { aniso });
}

export function makeRoofTiles(aniso, color = [150, 62, 50]) {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(31);
  const rows = 12;
  for (let r = 0; r < rows; r++) {
    const h = H / rows;
    for (let x = -(r % 2) * 16; x < W; x += 32) {
      const k = 0.85 + rand() * 0.3;
      ctx.fillStyle = `rgb(${color[0] * k},${color[1] * k},${color[2] * k})`;
      ctx.beginPath(); ctx.roundRect(x + 1, r * h, 30, h + 4, 5); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
    }
  }
  return tex(c, { aniso });
}

export function makeConcrete(aniso) {
  const W = 256, H = 256;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(41);
  ctx.fillStyle = '#8d8f94'; ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, 30000, rand, 90, 190, 0.35);
  ctx.strokeStyle = 'rgba(40,40,44,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.moveTo(0, 0); ctx.lineTo(0, H); ctx.stroke();
  return tex(c, { aniso });
}

/** A soft cloud puff (white with soft alpha) for billboards. */
export function makeCloud() {
  const W = 512, H = 256;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(51);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  // a cartoon cumulus: a row of overlapping puffs, tallest in the middle, with a flat base
  const base = H * 0.74;
  const puffs = 7;
  for (let i = 0; i < puffs; i++) {
    const u = (i + 0.5) / puffs;
    const hump = Math.sin(u * Math.PI);
    const r = H * (0.13 + 0.2 * hump) * (0.85 + rand() * 0.3);
    const x = W * (0.12 + 0.76 * u);
    ctx.beginPath(); ctx.arc(x, base - r * 0.85, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillRect(W * 0.12, base - H * 0.08, W * 0.76, H * 0.08);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillRect(0, base, W, H - base); // flat bottom
  return tex(c, { repeat: false });
}

/** A tuft of grass blades with alpha, drawn upward from the bottom centre. */
export function makeGrassTuft(color = [92, 150, 60]) {
  const W = 128, H = 128;
  const [c, ctx] = canvas(W, H);
  const rand = mulberry32(61);
  for (let i = 0; i < 26; i++) {
    const x = W / 2 + (rand() - 0.5) * 70;
    const h = 50 + rand() * 70;
    const lean = (rand() - 0.5) * 46;
    const k = 0.7 + rand() * 0.6;
    ctx.fillStyle = `rgb(${color[0] * k},${color[1] * k},${color[2] * k})`;
    ctx.beginPath();
    ctx.moveTo(x - 3.5, H);
    ctx.quadraticCurveTo(x + lean * 0.3, H - h * 0.6, x + lean, H - h);
    ctx.quadraticCurveTo(x + lean * 0.3 + 3, H - h * 0.55, x + 3.5, H);
    ctx.fill();
  }
  return tex(c, { repeat: false });
}

/** Chevron warning board for sharp bends. */
export function makeChevron() {
  const [c, ctx] = canvas(128, 96);
  ctx.fillStyle = '#f2c500'; ctx.fillRect(0, 0, 128, 96);
  ctx.strokeStyle = '#151515'; ctx.lineWidth = 14; ctx.lineJoin = 'miter';
  ctx.beginPath(); ctx.moveTo(34, 12); ctx.lineTo(82, 48); ctx.lineTo(34, 84); ctx.stroke();
  ctx.lineWidth = 4; ctx.strokeRect(2, 2, 124, 92);
  return tex(c, { repeat: false });
}

/** A rounded sign with text (banners, km markers, name tags). Returns {texture, aspect}. */
export function makeSign(text, { w = 512, h = 128, bg = '#1c2330', fg = '#ffffff', font = 800, size = 0.52, border = null, round = 18 } = {}) {
  const [c, ctx] = canvas(w, h);
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, round); ctx.fill();
  }
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 8; ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 8, round); ctx.stroke(); }
  let fs = h * size;
  ctx.font = `${font} ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const tw = ctx.measureText(text).width;
  if (tw > w * 0.9) { fs *= (w * 0.9) / tw; ctx.font = `${font} ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`; }
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + fs * 0.04);
  return { texture: tex(c, { repeat: false, aniso: 8 }), aspect: w / h };
}
