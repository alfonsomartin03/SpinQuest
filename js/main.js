// Wires devices, menu, game loop, HUD and persistence together.

import { Renderer } from './world/scene3d.js';
import { Game } from './game.js';
import { Hud, toast, showSummary, drawWorkoutProfile } from './hud.js';
import { WORKOUTS } from './workouts.js';
import { Sim } from './sim.js';
import {
  DataHub, connectTrainer, connectHeartRate, connectClick, bluetoothSupported, bluetoothProblem, explainError, getKnownDevices,
} from './ble.js';
import { VirtualGears, ResistanceControl, ergGuard, slew } from './gearing.js';
import { LoopbackSession, DemoPeers } from './net.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { ACHIEVEMENTS } from './achievements.js';
import { LANDMARKS } from './course.js';
import { DoubleClick } from './click.js';
import { buildFit, fitFileName, PLACES, MIN_SECONDS } from './export.js';
import { levelFor, levelTitle, xpForLevel, defaultHrLimits, cleanHrLimits } from './physics.js';

window.__sqLoaded = true;
// ?debug=1 exposes the running game on window.__sq, for poking at it from the console
if (new URLSearchParams(location.search).has('debug')) Object.defineProperty(window, '__sq', { get: () => ({ game, renderer, mode }) });
const $ = (id) => document.getElementById(id);

// ---- persistence ------------------------------------------------------------------

const store = {
  get(key, fallback) {
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const profile = store.get('spinquest.profile', { name: '', weight: 75, ftp: 200, maxHr: 190, workout: 'free', control: 'gears', autoShift: true, cadLow: 80, cadHigh: 100, hrLimits: null, clickSwap: false });
const progress = store.get('spinquest.progress', { xp: 0, rides: 0, km: 0 });
const known = store.get('spinquest.devices', {}); // last-used device per kind, for one-tap reconnect
progress.ach ||= {};
progress.segPR ||= {};
progress.discovered ||= {};
const saveProgress = () => store.set('spinquest.progress', progress);

// ---- state ----------------------------------------------------------------------------

const hub = new DataHub();
const links = { trainer: null, hr: null, click: null };
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

// optional demo of the multiplayer path: ?demo=remote adds three simulated live riders over a laggy fake network
const demoRemote = new URLSearchParams(location.search).get('demo') === 'remote';
let net = null;
function startNet() {
  stopNet();
  if (!demoRemote) return;
  const session = new LoopbackSession({ latencyMs: 90, jitterMs: 50 });
  const peers = new DemoPeers(session, { count: 3, startX: game.user.x });
  net = { session, peers, off: session.onState((st) => game.applyRemote(st)) };
}
function stopNet() { net?.off(); net = null; }

// trainer control during a ride
let gears = null;
let resist = null;
let ctlActive = false;
let cadSmooth = 0;
let cadFast = 0;
let cmdWatts = null;
let sendTimer = 0;

// ---- menu -------------------------------------------------------------------------------

if (!bluetoothSupported()) {
  $('bt-warning').textContent = bluetoothProblem();
  $('bt-warning').hidden = false;
}

/** Custom HR zone ceilings from the menu, or null while they are just following Max HR. */
function readHrLimits() {
  if ($('hrzones').dataset.custom !== '1') return null;
  return cleanHrLimits([1, 2, 3, 4].map((i) => parseFloat($(`hrz-${i}`).value))) ?? profile.hrLimits; // half-typed: keep the last good set
}

function showHrLimits() {
  const custom = cleanHrLimits(profile.hrLimits);
  const maxHr = parseFloat($('p-maxhr').value) || profile.maxHr;
  $('hrzones').dataset.custom = custom ? '1' : '0';
  (custom ?? defaultHrLimits(maxHr)).forEach((v, i) => { $(`hrz-${i + 1}`).value = v; });
  $('hrz-note').textContent = custom ? '(custom)' : '(from Max HR)';
  $('hrz-reset').hidden = !custom;
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
    hrLimits: readHrLimits(),
    clickSwap: $('click-swap').checked,
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
  showHrLimits();
  $('click-swap').checked = !!profile.clickSwap;
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
    if (canControl() && p.control === 'gears') hint = 'Cadence control on: resistance keeps you in your cadence range. Shift with ← → or the + − buttons.';
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
// HR zones: typing in a zone box makes them custom; until then they follow Max HR
[1, 2, 3, 4].forEach((i) => $(`hrz-${i}`).addEventListener('input', () => {
  $('hrzones').dataset.custom = '1';
  $('hrz-note').textContent = '(custom)';
  $('hrz-reset').hidden = false;
}));
$('p-maxhr').addEventListener('input', () => {
  if ($('hrzones').dataset.custom !== '1') defaultHrLimits(parseFloat($('p-maxhr').value) || profile.maxHr).forEach((v, i) => { $(`hrz-${i + 1}`).value = v; });
});
$('hrz-reset').addEventListener('click', () => { profile.hrLimits = null; showHrLimits(); refreshMenu(); });
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

const CARD = { trainer: 'dev-trainer', hr: 'dev-hr', click: 'dev-click' };
const KINDS = Object.keys(CARD);

function deviceUi(kind) {
  const card = $(CARD[kind]);
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
      toast({ text: { trainer: 'Trainer', hr: 'HR strap', click: 'Zwift Click' }[kind], sub: status.textContent, kind: state === 'connected' ? 'go' : 'combo' });
    }
    refreshMenu();
  };
}

/** Connect (or disconnect) a device. `opts.device` reconnects a remembered one without the picker. */
async function connectDevice(kind, opts = {}) {
  const card = $(CARD[kind]);
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
    const emit = kind === 'click' ? onClickButton : (f) => hub.push(f);
    const link = await { trainer: connectTrainer, hr: connectHeartRate, click: connectClick }[kind](emit, ui, { all: opts.all ?? $('show-all').checked, device: opts.device });
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

for (const kind of KINDS) {
  const card = $(CARD[kind]);
  card.ui = deviceUi(kind);
  card.querySelector('[data-connect]').addEventListener('click', () => connectDevice(kind));
  card.querySelector('[data-all]').addEventListener('click', () => connectDevice(kind, { all: true }));
}

/** Offer one-tap reconnect to devices this browser already knows (no pairing list at all). */
async function offerKnownDevices() {
  if (!bluetoothSupported()) return;
  const devices = await getKnownDevices();
  for (const kind of KINDS) {
    const dev = devices.find((d) => d.id === known[kind]?.id);
    if (!dev) continue;
    const btn = $(CARD[kind]).querySelector('[data-reconnect]');
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
  if (!ctlActive || !gears || profile.control !== 'gears') return false;
  if (gears.shift(dir)) { sfx('step'); showGear(true); return true; }
  return false;
}

// A double click of the Zwift Click (either button, twice within a moment) takes or cancels the extension while the turn
// point is in sight. The first press has already changed gear by then, so that shift is handed back: a double click
// leaves your gear alone.
const clicks = new DoubleClick();
function onClickButton(dir) {
  const step = profile.clickSwap ? -dir : dir;
  const res = clicks.press(performance.now(), mode === 'ride' && game?.extension().state === 'approach');
  if (res.double) {
    if (res.undo) shiftGear(-res.undo);
    game.toggleExtension();
    return;
  }
  clicks.record(shiftGear(step) ? step : 0);
}
$('g-up').addEventListener('click', () => shiftGear(+1));
$('g-down').addEventListener('click', () => shiftGear(-1));

/**
 * Each frame: decide what resistance to ask the trainer for.
 *  - Virtual gears: a cadence-band controller. Resistance holds while your cadence is inside your range, firms up
 *    only when you reach the top of it (you are pushing harder) and eases off when cadence drops (you are easing
 *    off or grinding). It never tries to hold a power at the cost of your cadence.
 *  - ERG: holds the workout's watts, but eases the target if cadence falls below your range.
 */
function driveTrainer(dt) {
  const c = links.trainer?.control;
  if (!ctlActive || !c) return;
  if (c.state === 'idle') c.acquire();
  const cad = hub.get('cadence') ?? 0;
  cadSmooth += (cad - cadSmooth) * (1 - Math.exp(-dt / 1.0));
  cadFast += (cad - cadFast) * (1 - Math.exp(-dt / 0.3));
  if (c.state !== 'ready') { showGear(); return; }

  let want;
  const erg = profile.control === 'erg' && game.target;
  const ctx = { grade: game.grade, mass: game.mass, drag: game.user.drag };
  if (game.finished || game.paused) want = 0;
  else if (erg) want = ergGuard(game.wo ? game.wo.watts : game.target.watts, cadFast, gears.low);
  else {
    const before = resist.physics(ctx);
    const dir = gears.update(dt, cadSmooth);
    if (dir) { resist.compensate(before, resist.physics(ctx)); sfx('step'); showGear(true); } // auto-shifts don't jolt the feel
    want = resist.update(dt, cad, ctx);
  }
  cmdWatts = slew(cmdWatts, Math.min(want, 2000), dt, 600);
  sendTimer += dt;
  if (sendTimer >= 0.25) { sendTimer = 0; c.setTargetPower(cmdWatts); }
  showGear();
}

// ---- ride export (.fit) -------------------------------------------------------------------------
// The file only ever exists in memory: it is dropped when the next ride starts, and never saved anywhere else.

let fit = null; // { bytes, name, place } for the ride that just ended

function makeFit(place = PLACES[0]) {
  const ok = game && game.startedAt && game.samples.length >= MIN_SECONDS;
  fit = ok ? { bytes: buildFit({ samples: game.samples, startedAt: game.startedAt, place }), name: fitFileName(game.startedAt), place } : null;
  $('s-fit').hidden = !fit;
  $('m-fit').hidden = $('m-fit-note').hidden = !fit;
}

function downloadFit() {
  if (!fit) return;
  const url = URL.createObjectURL(new Blob([fit.bytes], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fit.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast({ text: 'Downloaded', sub: `${fit.name}: placed at ${fit.place.name}`, kind: 'go' });
}
$('s-fit-dl').addEventListener('click', downloadFit);
$('m-fit').addEventListener('click', downloadFit);

// ---- game flow ------------------------------------------------------------------------------

// ---- keep the screen on during a ride ---------------------------------------------------------------
// Screen Wake Lock (Chrome, Edge, Safari 16.4+). The browser drops the lock whenever the tab is hidden, so take it again
// when the tab comes back; where the API is missing there is nothing to do.
let wakeLock = null;
async function holdScreen() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { wakeLock = null; /* low battery, or the browser said no: the screen may dim as usual */ }
}
function releaseScreen() { wakeLock?.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (mode === 'ride') holdScreen(); });

function startRide() {
  holdScreen();
  initAudio();
  fit = null; // the previous ride's file is deleted if it was never downloaded
  $('m-fit').hidden = $('m-fit-note').hidden = true;
  const p = readProfile();
  const workout = WORKOUTS.find((w) => w.id === p.workout);
  useSim = !links.trainer;
  sim = new Sim(p);
  game = new Game({ profile: { ...p, name: p.name || 'You' }, workout, progress });
  game.xpAtStart = progress.xp;
  game.levelAtStart = levelFor(progress.xp);

  ctlActive = !useSim && canControl() && p.control !== 'off';
  gears = new VirtualGears({ auto: p.autoShift, low: p.cadLow, high: p.cadHigh });
  resist = new ResistanceControl(gears, p.ftp);
  cadSmooth = 0;
  cadFast = 0;
  cmdWatts = null;
  sendTimer = 0;
  if (ctlActive) links.trainer.control.acquire();
  $('h-gear').hidden = true;
  startNet();

  mode = 'ride';
  $('menu').hidden = true;
  $('summary').hidden = true;
  $('hud').hidden = false;
  clearTimeout(endTimer);
  endTimer = null;
}

function endRide() {
  if (mode !== 'ride') return;
  releaseScreen();
  mode = 'summary';
  clearTimeout(endTimer);
  endTimer = null;
  links.trainer?.control?.release(); // hand resistance back to the rider
  ctlActive = false;
  stopNet();
  const sum = game.summary();
  progress.xp += sum.score;
  progress.rides += 1;
  progress.km += sum.distance / 1000;
  saveProgress();
  $('hud').hidden = true;
  showSummary(game, game.levelAtStart, game.xpAtStart);
  $('summary').hidden = false;
  makeFit();
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
  if (e.key === 'e' && game) game.toggleExtension(); // take (or cancel) the extension when the turn point is near
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
    net?.peers.tick(dt);
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
