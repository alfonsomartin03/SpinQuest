// Wires devices, menu, game loop, HUD and persistence together.

import { Renderer } from './world/scene3d.js';
import { Game } from './game.js';
import { Hud, toast, showSummary, drawWorkoutProfile } from './hud.js';
import { WORKOUTS } from './workouts.js';
import { Sim } from './sim.js';
import {
  DataHub, connectTrainer, connectHeartRate, bluetoothSupported, bluetoothProblem, explainError, getKnownDevices,
} from './ble.js';
import { VirtualGears, slew } from './gearing.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { ACHIEVEMENTS } from './achievements.js';
import { LANDMARKS } from './course.js';
import { levelFor, levelTitle, xpForLevel } from './physics.js';

window.__sqLoaded = true;
const $ = (id) => document.getElementById(id);

// ---- persistence ------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const profile = store.get('spinquest.profile', { name: '', weight: 75, ftp: 200, maxHr: 190, workout: 'free', control: 'gears', autoShift: true, cadLow: 80, cadHigh: 100 });
const progress = store.get('spinquest.progress', { xp: 0, rides: 0, km: 0 });
const known = store.get('spinquest.devices', {}); // last-used device per kind, for one-tap reconnect
progress.ach ||= {};
progress.segPR ||= {};
progress.discovered ||= {};
const saveProgress = () => store.set('spinquest.progress', progress);

// ---- state ----------------------------------------------------------------------------

const hub = new DataHub();
const links = { trainer: null, hr: null };
const renderer = new Renderer($('scene'));
addEventListener('resize', () => renderer.resize());
const hud = new Hud();
let mode = 'menu'; // menu | ride | summary
let game = null;
let sim = null;
let useSim = false;
let attract = null;
let attractSim = null;
let endTimer = null;
let last = performance.now();

// trainer control during a ride
let gears = null;
let ctlActive = false;
let cadSmooth = 0;
let cmdWatts = null;
let sendTimer = 0;

// ---- menu -------------------------------------------------------------------------------

if (!bluetoothSupported()) {
  $('bt-warning').textContent = bluetoothProblem();
  $('bt-warning').hidden = false;
}

function readProfile() {
  const num = (id, lo, hi, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  Object.assign(profile, {
    name: $('p-name').value.trim(),
    weight: num('p-weight', 30, 200, 75),
    ftp: num('p-ftp', 50, 600, 200),
    maxHr: num('p-maxhr', 120, 230, 190),
    workout: $('workout').value,
    control: document.querySelector('input[name=ctlmode]:checked')?.value ?? profile.control,
    autoShift: $('autoshift').checked,
    cadLow: num('cad-low', 50, 110, 80),
    cadHigh: num('cad-high', 60, 130, 100),
  });
  if (profile.cadHigh < profile.cadLow + 10) profile.cadHigh = profile.cadLow + 10; // keep a usable window
  store.set('spinquest.profile', profile);
  return profile;
}

function fillMenu() {
  $('p-name').value = profile.name;
  $('p-weight').value = profile.weight;
  $('p-ftp').value = profile.ftp;
  $('p-maxhr').value = profile.maxHr;
  $('workout').innerHTML = WORKOUTS.map((w) => `<option value="${w.id}">${w.name}</option>`).join('');
  $('workout').value = WORKOUTS.some((w) => w.id === profile.workout) ? profile.workout : 'free';
  const radio = document.querySelector(`input[name=ctlmode][value=${profile.control}]`);
  if (radio) radio.checked = true;
  $('autoshift').checked = profile.autoShift !== false;
  $('cad-low').value = profile.cadLow;
  $('cad-high').value = profile.cadHigh;
  refreshMenu();
}

const controlState = () => links.trainer?.control?.state ?? 'none';
const canControl = () => ['idle', 'requesting', 'ready'].includes(controlState());

function refreshMenu() {
  const p = readProfile();
  const w = WORKOUTS.find((x) => x.id === p.workout);
  $('workout-desc').textContent = w.desc;
  drawWorkoutProfile($('workout-preview'), w, p.ftp);
  const lvl = levelFor(progress.xp);
  $('m-level').textContent = `Level ${lvl}`;
  $('m-title').textContent = levelTitle(lvl);
  $('m-xpbar').style.width = `${((progress.xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl))) * 100}%`;
  $('m-xp').textContent = `${progress.xp.toLocaleString()} XP · ${Object.keys(progress.ach).length}/${ACHIEVEMENTS.length} achievements · ${Object.keys(progress.discovered).length}/${LANDMARKS.length} landmarks`;
  let hint = 'No trainer connected: you will ride with the keyboard simulator.';
  if (links.trainer) {
    if (canControl() && p.control === 'gears') hint = 'Virtual gears on: shift with ← → or the + − buttons. Stop pedalling and the ride pauses.';
    else if (canControl() && p.control === 'erg') hint = 'ERG on: the trainer holds each workout interval for you.';
    else hint = 'Set your trainer power yourself. SpinQuest only listens.';
  }
  $('start-hint').textContent = hint;
  $('start').textContent = links.trainer ? 'Start ride' : 'Start with simulator';
  $('autoshift').closest('label').hidden = p.control !== 'gears';
  $('cadrange').hidden = p.control !== 'gears';
  $('cadrange').classList.toggle('off', !p.autoShift);
  $('cad-low').disabled = $('cad-high').disabled = !p.autoShift;
}
document.querySelectorAll('#menu input, #menu select').forEach((el) => el.addEventListener('input', refreshMenu));
for (const id of ['cad-low', 'cad-high']) { // tidy the numbers once typing is finished
  $(id).addEventListener('change', () => { readProfile(); $('cad-low').value = profile.cadLow; $('cad-high').value = profile.cadHigh; });
}

/** Show or hide the resistance-control options for the connected trainer. */
function updateControlUi() {
  const sec = $('ctl');
  const link = links.trainer;
  sec.hidden = !link;
  if (!link) return;
  const c = link.control;
  const st = c?.state ?? 'none';
  const usable = ['idle', 'requesting', 'ready'].includes(st);
  sec.classList.toggle('denied', st === 'denied');
  sec.querySelectorAll('input').forEach((el) => { el.disabled = !usable; });
  $('ctl-note').textContent = {
    none: `${c?.reason || 'This device cannot be controlled.'} SpinQuest will listen only.`,
    idle: 'Your trainer supports resistance control.',
    requesting: 'Taking control of your trainer…',
    ready: 'You have control of your trainer. Resistance will follow the game.',
    denied: `${c?.reason || 'Control was refused.'} Close other apps that control it, or choose Listen only.`,
  }[st] || '';
  refreshMenu();
}

function deviceUi(kind) {
  const card = $(kind === 'trainer' ? 'dev-trainer' : 'dev-hr');
  const status = card.querySelector('[data-status]');
  const btn = card.querySelector('[data-connect]');
  return (state, name) => {
    card.classList.toggle('connected', state === 'connected');
    card.classList.toggle('reconnecting', state === 'reconnecting');
    status.textContent = {
      idle: 'Not connected', connected: `Connected: ${name}`, reconnecting: `Reconnecting to ${name}…`, lost: `Lost ${name}`, connecting: 'Choose a device…',
    }[state] || state;
    btn.textContent = state === 'connected' ? 'Disconnect' : 'Connect';
    if (state === 'connected') card.querySelector('[data-all]').hidden = true;
    if (mode === 'ride' && ['reconnecting', 'lost', 'connected'].includes(state) && links[kind]) {
      toast({ text: kind === 'trainer' ? 'Trainer' : 'HR strap', sub: status.textContent, kind: state === 'connected' ? 'go' : 'combo' });
    }
    refreshMenu();
  };
}

/** Connect (or disconnect) a device. `opts.device` reconnects a remembered one without the picker. */
async function connectDevice(kind, opts = {}) {
  const card = $(kind === 'trainer' ? 'dev-trainer' : 'dev-hr');
  const ui = card.ui;
  const statusEl = card.querySelector('[data-status]');
  if (links[kind] && !opts.force) {
    links[kind].close();
    links[kind] = null;
    if (kind === 'trainer') updateControlUi();
    return;
  }
  if (!bluetoothSupported()) { ui('idle'); statusEl.textContent = bluetoothProblem(); return; }
  ui('connecting');
  if (opts.device) statusEl.textContent = `Looking for ${opts.device.name || 'your device'}…`;
  card.querySelector('[data-all]').hidden = true;
  try {
    const emit = (f) => hub.push(f);
    const link = await (kind === 'trainer' ? connectTrainer : connectHeartRate)(emit, ui, { all: opts.all ?? $('show-all').checked, device: opts.device });
    links[kind] = link;
    known[kind] = { id: link.device.id, name: link.name };
    store.set('spinquest.devices', known);
    card.querySelector('[data-reconnect]').hidden = true;
    if (kind === 'trainer') {
      link.control.onState = (st) => {
        updateControlUi();
        if (mode === 'ride' && ctlActive && ['denied', 'ready'].includes(st)) {
          toast({ text: 'Trainer control', sub: st === 'ready' ? 'Resistance is now controlled by SpinQuest' : link.control.reason, kind: st === 'ready' ? 'go' : 'combo' });
        }
      };
      updateControlUi();
    }
  } catch (err) {
    links[kind] = null;
    ui('idle');
    console.warn('Bluetooth connect failed', err);
    statusEl.textContent = explainError(err);
    if (err.name === 'NotFoundError' && !opts.all) card.querySelector('[data-all]').hidden = false;
    if (opts.device) card.querySelector('[data-reconnect]').hidden = false;
  }
}

for (const kind of ['trainer', 'hr']) {
  const card = $(kind === 'trainer' ? 'dev-trainer' : 'dev-hr');
  card.ui = deviceUi(kind);
  card.querySelector('[data-connect]').addEventListener('click', () => connectDevice(kind));
  card.querySelector('[data-all]').addEventListener('click', () => connectDevice(kind, { all: true }));
}

/** Offer one-tap reconnect to devices this browser already knows (no pairing list at all). */
async function offerKnownDevices() {
  if (!bluetoothSupported()) return;
  const devices = await getKnownDevices();
  for (const kind of ['trainer', 'hr']) {
    const dev = devices.find((d) => d.id === known[kind]?.id);
    if (!dev) continue;
    const btn = $(kind === 'trainer' ? 'dev-trainer' : 'dev-hr').querySelector('[data-reconnect]');
    btn.textContent = `Reconnect ${dev.name || known[kind].name}`;
    btn.hidden = false;
    btn.onclick = () => connectDevice(kind, { device: dev });
  }
}
offerKnownDevices();

// ---- trainer control (virtual gears / ERG) -------------------------------------------------------

function showGear(flash = false) {
  const box = $('h-gear');
  box.hidden = !(ctlActive && profile.control === 'gears');
  if (box.hidden) return;
  $('g-num').textContent = String(gears.gear);
  const rpm = Math.round(cadSmooth);
  $('g-info').textContent = `${gears.ratio.toFixed(2)} · ${rpm || '--'} rpm${gears.auto ? ` · auto ${gears.low}–${gears.high}` : ''}`;
  box.classList.toggle('sweet', rpm >= gears.low && rpm <= gears.high);
  if (flash) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
}

function shiftGear(dir) {
  if (!ctlActive || !gears || profile.control !== 'gears') return;
  if (gears.shift(dir)) { sfx('step'); showGear(true); }
}
$('g-up').addEventListener('click', () => shiftGear(+1));
$('g-down').addEventListener('click', () => shiftGear(-1));

/** Each frame: work out the resistance the road and gear imply, and ask the trainer for it. */
function driveTrainer(dt) {
  const c = links.trainer?.control;
  if (!ctlActive || !c) return;
  if (c.state === 'idle') c.acquire();
  const cad = hub.get('cadence') ?? 0;
  cadSmooth += (cad - cadSmooth) * (1 - Math.exp(-dt / 1.0));
  if (c.state !== 'ready') { showGear(); return; }

  let want;
  const erg = profile.control === 'erg' && game.target;
  if (game.finished || game.paused) want = 0;
  else if (erg) want = game.wo ? game.wo.watts : game.target.watts;
  else {
    const dir = gears.update(dt, cadSmooth);
    if (dir) { sfx('step'); showGear(true); }
    want = gears.targetPower({ cadence: cadSmooth, grade: game.grade, mass: game.mass, drag: game.user.drag });
  }
  cmdWatts = slew(cmdWatts, Math.min(want, 2000), dt);
  sendTimer += dt;
  if (sendTimer >= 0.5) { sendTimer = 0; c.setTargetPower(cmdWatts); }
  showGear();
}

// ---- game flow ------------------------------------------------------------------------------

function startRide() {
  initAudio();
  const p = readProfile();
  const workout = WORKOUTS.find((w) => w.id === p.workout);
  useSim = !links.trainer;
  sim = new Sim(p);
  game = new Game({ profile: { ...p, name: p.name || 'You' }, workout, progress });
  game.xpAtStart = progress.xp;
  game.levelAtStart = levelFor(progress.xp);

  ctlActive = !useSim && canControl() && p.control !== 'off';
  gears = new VirtualGears({ auto: p.autoShift, low: p.cadLow, high: p.cadHigh });
  cadSmooth = 0;
  cmdWatts = null;
  sendTimer = 0;
  if (ctlActive) links.trainer.control.acquire();
  $('h-gear').hidden = true;

  mode = 'ride';
  $('menu').hidden = true;
  $('summary').hidden = true;
  $('hud').hidden = false;
  clearTimeout(endTimer);
  endTimer = null;
}

function endRide() {
  if (mode !== 'ride') return;
  mode = 'summary';
  clearTimeout(endTimer);
  endTimer = null;
  links.trainer?.control?.release(); // hand resistance back to the rider
  ctlActive = false;
  const sum = game.summary();
  progress.xp += sum.score;
  progress.rides += 1;
  progress.km += sum.distance / 1000;
  saveProgress();
  $('hud').hidden = true;
  showSummary(game, game.levelAtStart, game.xpAtStart);
  $('summary').hidden = false;
}

function toMenu() {
  mode = 'menu';
  $('summary').hidden = true;
  $('menu').hidden = false;
  updateControlUi();
}

$('start').addEventListener('click', startRide);
$('btn-finish').addEventListener('click', endRide);
$('s-again').addEventListener('click', toMenu);
$('btn-mute').addEventListener('click', () => {
  setMuted(!isMuted());
  $('btn-mute').textContent = isMuted() ? '🔇' : '🔊';
});
addEventListener('beforeunload', () => { saveProgress(); links.trainer?.control?.release(); });

// ---- keys: shifting with a trainer, power with the simulator ---------------------------------------

addEventListener('keydown', (e) => {
  if (mode !== 'ride') return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (ctlActive) {
    if (e.key === 'ArrowRight' || e.key === '.') { shiftGear(+1); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === ',') { shiftGear(-1); e.preventDefault(); }
  }
  if (e.key === 'm') $('btn-mute').click();
  if (!sim || !useSim) return;
  const step = { ArrowUp: 10, ArrowDown: -10, PageUp: 50, PageDown: -50 }[e.key];
  if (step) { sim.offset += step; e.preventDefault(); }
  if (e.code === 'Space') { sim.sprint = true; e.preventDefault(); }
  if (e.key === 'p') sim.stopped = !sim.stopped;
});
addEventListener('keyup', (e) => { if (e.code === 'Space' && sim) sim.sprint = false; });

// ---- main loop ------------------------------------------------------------------------------------

function readInputs(dt) {
  if (useSim) {
    const s = sim.update(dt, game.target ? game.target.watts : null);
    const real = hub.snapshot();
    return { power: s.power, cadence: s.cadence, hr: real.hr ?? s.hr };
  }
  const d = hub.snapshot();
  return { power: d.power ?? 0, cadence: d.cadence, hr: d.hr };
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (mode === 'ride') {
    game.update(dt, readInputs(dt));
    driveTrainer(dt);
    const events = game.drain();
    for (const e of events) {
      if (e.type === 'toast') toast(e);
      else if (e.type === 'sfx') sfx(e.name);
    }
    renderer.handleEvents(events);
    hud.update(game, useSim);
    renderer.draw(game, dt);
    if (game.finished && !endTimer) endTimer = setTimeout(endRide, 4000);
  } else {
    if (!attract) {
      const done = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, 1]));
      const p = { name: 'You', weight: 75, ftp: 200, maxHr: 190 };
      attract = new Game({ profile: p, workout: WORKOUTS[0], progress: { xp: 0, ach: done, segPR: {}, discovered: {} } });
      attractSim = new Sim(p);
    }
    attract.update(dt, attractSim.update(dt, null));
    attract.drain();
    renderer.draw(attract, dt);
  }
  requestAnimationFrame(frame);
}

fillMenu();
updateControlUi();

// graphics quality
$('quality').value = renderer.quality;
$('quality').addEventListener('change', () => renderer.applyQuality($('quality').value));

// build the 3D world behind a loading screen, then start the loop
(async function init() {
  const bar = $('loader-bar'), text = $('loader-text');
  try {
    await renderer.build((p, label) => { bar.style.width = `${Math.round(p * 100)}%`; text.textContent = label; });
  } catch (err) {
    console.error(err);
    text.textContent = "Couldn't start the 3D world";
    const e = $('loader-error');
    e.hidden = false;
    e.textContent = `${err.message || err}. SpinQuest needs a browser with WebGL 2 (current Chrome, Edge, Safari or Firefox).`;
    return;
  }
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 800);
  last = performance.now();
  requestAnimationFrame(frame);
})();
