// Wires devices, menu, game loop, HUD and persistence together.

import { Renderer } from './world/scene3d.js';
import { Game } from './game.js';
import { Hud, toast, showSummary, drawWorkoutProfile } from './hud.js';
import { WORKOUTS, ergWorkout } from './workouts.js';
import { Sim } from './sim.js';
import {
  DataHub, connectTrainer, connectHeartRate, connectClick, bluetoothSupported, bluetoothProblem, explainError, getKnownDevices,
} from './ble.js';
import { VirtualGears, GearResistance, ergGuard, slew } from './gearing.js';
import { LoopbackSession, DemoPeers } from './net.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { ACHIEVEMENTS } from './achievements.js';
import { LANDMARKS } from './course.js';
import { DoubleClick } from './click.js';
import { buildFit, fitFileName, PLACES, MIN_SECONDS } from './export.js';
import { levelFor, levelTitle, xpForLevel, defaultHrLimits, cleanHrLimits, clamp } from './physics.js';
import { t, applyDom, getLang, setLang, onLangChange, locale } from './i18n.js';

window.__sqLoaded = true;
document.documentElement.lang = getLang();
applyDom();
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
const profile = store.get('spinquest.profile', { name: '', weight: 75, ftp: 200, maxHr: 190, mode: 'free', shift: 'auto', ergWatts: null, workout: null, control: 'on', cadLow: 80, cadHigh: 100, hrLimits: null, clickSwap: false });
const STRUCTURED = WORKOUTS.filter((w) => w.steps.length);
// settings saved by earlier versions: a structured workout meant workout mode, "listen only" meant no resistance control
if (!profile.mode) {
  profile.mode = profile.workout && profile.workout !== 'free' && STRUCTURED.some((w) => w.id === profile.workout) ? 'workout' : 'free';
  profile.shift = profile.autoShift === false ? 'manual' : 'auto';
  profile.control = profile.control === 'off' ? 'off' : 'on';
}
if (!STRUCTURED.some((w) => w.id === profile.workout)) profile.workout = STRUCTURED[0].id;
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
let rideMode = 'free'; // the mode this ride started in: free | erg | workout
let cadSmooth = 0;
let cadFast = 0;
let cmdWatts = null;
let sendTimer = 0;

// ---- menu -------------------------------------------------------------------------------

const showBtWarning = () => { $('bt-warning').textContent = bluetoothProblem(); $('bt-warning').hidden = false; };
if (!bluetoothSupported()) showBtWarning();

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
  $('hrz-note').textContent = t(custom ? '(custom)' : '(standard zones in use)');
  $('hrz-reset').hidden = !custom;
}

function readProfile() {
  const num = (id, lo, hi, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const checked = (name, fallback) => document.querySelector(`input[name=${name}]:checked`)?.value ?? fallback;
  const ftp = num('p-ftp', 50, 600, 200);
  Object.assign(profile, {
    name: $('p-name').value.trim(),
    weight: num('p-weight', 30, 200, 75),
    ftp,
    maxHr: num('p-maxhr', 120, 230, 190),
    mode: checked('ridemode', profile.mode),
    shift: checked('shiftmode', profile.shift),
    ergWatts: num('erg-watts', 30, 1000, Math.round((profile.ergWatts ?? 0.6 * ftp) / 5) * 5),
    workout: $('workout').value || profile.workout,
    control: $('resist-on').checked ? 'on' : 'off',
    cadLow: num('cad-low', 50, 110, 80),
    cadHigh: num('cad-high', 60, 130, 100),
    hrLimits: readHrLimits(),
    clickSwap: $('click-swap').checked,
  });
  if (profile.cadHigh < profile.cadLow + 10) profile.cadHigh = profile.cadLow + 10; // keep a usable window
  store.set('spinquest.profile', profile);
  return profile;
}

function fillWorkouts() {
  const cur = $('workout').value || profile.workout;
  $('workout').innerHTML = STRUCTURED.map((w) => `<option value="${w.id}">${t(w.name)}</option>`).join('');
  $('workout').value = cur;
}

function fillMenu() {
  $('p-name').value = profile.name;
  $('p-weight').value = profile.weight;
  $('p-ftp').value = profile.ftp;
  $('p-maxhr').value = profile.maxHr;
  showHrLimits();
  $('click-swap').checked = !!profile.clickSwap;
  fillWorkouts();
  $('workout').value = profile.workout;
  document.querySelector(`input[name=ridemode][value=${profile.mode}]`).checked = true;
  document.querySelector(`input[name=shiftmode][value=${profile.shift}]`).checked = true;
  $('erg-watts').value = Math.round((profile.ergWatts ?? 0.6 * profile.ftp) / 5) * 5;
  $('resist-on').checked = profile.control !== 'off';
  $('cad-low').value = profile.cadLow;
  $('cad-high').value = profile.cadHigh;
  refreshMenu();
}

const controlState = () => links.trainer?.control?.state ?? 'none';
const canControl = () => ['idle', 'requesting', 'ready'].includes(controlState());

function refreshMenu() {
  const p = readProfile();
  const w = STRUCTURED.find((x) => x.id === p.workout) ?? STRUCTURED[0];
  $('workout-desc').textContent = t(w.desc);
  drawWorkoutProfile($('workout-preview'), w, p.ftp);
  document.querySelectorAll('.modebox').forEach((box) => { box.hidden = box.dataset.for !== p.mode; });
  const lvl = levelFor(progress.xp);
  $('m-level').textContent = t('Level {n}', { n: lvl });
  $('m-title').textContent = t(levelTitle(lvl));
  $('m-xpbar').style.width = `${((progress.xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl))) * 100}%`;
  $('m-xp').textContent = t('{xp} XP · {a}/{at} achievements · {l}/{lt} landmarks', { xp: progress.xp.toLocaleString(locale()), a: Object.keys(progress.ach).length, at: ACHIEVEMENTS.length, l: Object.keys(progress.discovered).length, lt: LANDMARKS.length });
  let hint = t('No trainer? No problem: you will ride with the keyboard.');
  if (links.trainer) {
    if (canControl() && p.control !== 'off') {
      hint = {
        free: p.shift === 'auto'
          ? t('Gears change for you. You choose how hard to pedal.')
          : t('You change gear: Zwift Click, + − buttons or ← →.'),
        erg: t('The trainer holds {watts} watts. Change it with + and −.', { watts: p.ergWatts }),
        workout: t('The trainer sets each interval for you.'),
      }[p.mode];
    } else hint = t('You set the power on your trainer. SpinQuest just reads it.');
  }
  $('start-hint').textContent = hint;
  $('start').textContent = t(links.trainer ? 'Start ride' : 'Start with keyboard');
  // the cadence range steers auto-shift, and guards ERG and workout targets against grinding
  const autoOn = p.mode === 'free' && p.shift === 'auto';
  $('cadrange').classList.toggle('off', p.mode === 'free' && !autoOn);
  $('cad-low').disabled = $('cad-high').disabled = p.mode === 'free' && !autoOn;
  $('cad-note').textContent = t(autoOn ? 'Auto-shift changes gear when you pedal slower or faster than this.'
    : p.mode === 'free' ? 'Only used by auto-shift.'
      : 'If you pedal slower than the first number, the trainer eases off so you never grind.');
}
// HR zones: typing in a zone box makes them custom; until then they follow Max HR
[1, 2, 3, 4].forEach((i) => $(`hrz-${i}`).addEventListener('input', () => {
  $('hrzones').dataset.custom = '1';
  $('hrz-note').textContent = t('(custom)');
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
    none: `${c?.reason || t('Resistance cannot be controlled on this device.')} ${t('SpinQuest will just read your power.')}`,
    idle: t('Your trainer can be controlled by SpinQuest.'),
    requesting: t('Connecting to your trainer\'s resistance…'),
    ready: t('SpinQuest is setting your trainer\'s resistance.'),
    denied: `${c?.reason || t('Control was refused.')} ${t('Close any other app using the trainer, or untick the box below.')}`,
  }[st] || '';
  refreshMenu();
}

const CARD = { trainer: 'dev-trainer', hr: 'dev-hr', click: 'dev-click' };
const KINDS = Object.keys(CARD);

/** Show a status line on a device card; kept as a function so it can be re-worded when the language changes. */
function setStatus(kind, fn) {
  const card = $(CARD[kind]);
  card.statusFn = fn;
  card.querySelector('[data-status]').textContent = fn();
}

function deviceUi(kind) {
  const card = $(CARD[kind]);
  const btn = card.querySelector('[data-connect]');
  return (state, name) => {
    card.classList.toggle('connected', state === 'connected');
    card.classList.toggle('reconnecting', state === 'reconnecting');
    card.btnState = state;
    setStatus(kind, () => ({
      idle: t('Not connected'), connected: t('Connected: {name}', { name }), reconnecting: t('Reconnecting to {name}…', { name }), lost: t('Lost {name}. Wake it and try again.', { name }), connecting: t('Pick your device in the popup…'),
    }[state] || state));
    btn.textContent = t(state === 'connected' ? 'Disconnect' : 'Connect');
    if (state === 'connected') card.querySelector('[data-all]').hidden = true;
    if (mode === 'ride' && ['reconnecting', 'lost', 'connected'].includes(state) && links[kind]) {
      const what = t({ trainer: 'Trainer', hr: 'Heart-rate strap', click: 'Zwift Click' }[kind]);
      const msg = {
        connected: [t('{what} connected', { what }), name],
        reconnecting: [t('{what} lost', { what }), t('Trying to reconnect…')],
        lost: [t('{what} disconnected', { what }), t('Wake it up and move it closer.')],
      }[state];
      toast({ text: msg[0], sub: msg[1], kind: state === 'connected' ? 'go' : 'combo' });
    }
    refreshMenu();
  };
}

/** Connect (or disconnect) a device. `opts.device` reconnects a remembered one without the picker. */
async function connectDevice(kind, opts = {}) {
  const card = $(CARD[kind]);
  const ui = card.ui;
  if (links[kind] && !opts.force) {
    links[kind].close();
    links[kind] = null;
    if (kind === 'trainer') updateControlUi();
    return;
  }
  if (!bluetoothSupported()) { ui('idle'); setStatus(kind, () => bluetoothProblem()); return; }
  ui('connecting');
  if (opts.device) setStatus(kind, () => t('Looking for {name}…', { name: opts.device.name || t('your device') }));
  card.querySelector('[data-all]').hidden = true;
  try {
    const emit = kind === 'click' ? onClickButton : (f) => hub.push(f);
    const link = await { trainer: connectTrainer, hr: connectHeartRate, click: connectClick }[kind](emit, ui, { all: opts.all ?? $('show-all').checked, device: opts.device, onRaw: kind === 'click' ? onClickFrame : undefined, onLog: kind === 'click' ? logClick : kind === 'trainer' ? logTrainer : undefined });
    links[kind] = link;
    known[kind] = { id: link.device.id, name: link.name };
    store.set('spinquest.devices', known);
    card.querySelector('[data-reconnect]').hidden = true;
    if (kind === 'trainer') {
      link.control.onState = (st) => {
        updateControlUi();
        if (mode === 'ride' && ctlActive && ['denied', 'ready'].includes(st)) {
          toast({ text: t(st === 'ready' ? 'Trainer control on' : 'Trainer control off'), sub: st === 'ready' ? t('SpinQuest now sets your resistance.') : link.control.reason, kind: st === 'ready' ? 'go' : 'combo' });
        }
      };
      updateControlUi();
    }
  } catch (err) {
    links[kind] = null;
    ui('idle');
    console.warn('Bluetooth connect failed', err);
    setStatus(kind, () => explainError(err));
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
    btn.dataset.name = dev.name || known[kind].name;
    btn.textContent = t('Reconnect {name}', { name: btn.dataset.name });
    btn.hidden = false;
    btn.onclick = () => connectDevice(kind, { device: dev });
  }
}
offerKnownDevices();

// ---- trainer control (virtual gears / ERG) -------------------------------------------------------

function showGear(flash = false) {
  const box = $('h-gear');
  const gearsOn = ctlActive && rideMode === 'free';
  const ergOn = rideMode === 'erg' && game?.workout.erg;
  box.hidden = !(gearsOn || ergOn);
  if (box.hidden) return;
  $('g-down').title = t(ergOn ? 'Lower the target (−10 W)' : 'Easier gear (←)');
  $('g-up').title = t(ergOn ? 'Raise the target (+10 W)' : 'Harder gear (→)');
  if (ergOn) {
    $('g-label').textContent = t('W target');
    $('g-num').textContent = String(ergWatts());
    $('g-info').textContent = t(ctlActive ? 'the trainer holds this' : 'the keyboard follows this');
    box.classList.remove('sweet');
  } else {
    $('g-label').textContent = t('gear');
    $('g-num').textContent = String(gears.gear);
    const rpm = Math.round(cadSmooth);
    $('g-info').textContent = `${rpm || '--'} rpm · ${t(gears.auto ? 'auto' : 'you shift')}`;
    box.classList.toggle('sweet', rpm >= gears.low && rpm <= gears.high);
  }
  if (flash) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }
}

/** The power ERG mode is holding (it lives in the workout's one step, as a fraction of FTP). */
const ergWatts = () => Math.round(game.workout.steps[0].to * game.profile.ftp);

/** + / − in ERG mode: nudge the target by 10 W. */
function adjustErg(dir) {
  const step = game?.workout.steps[0];
  if (!step) return false;
  const watts = clamp(ergWatts() + dir * 10, 30, 1000);
  step.from = step.to = watts / game.profile.ftp;
  profile.ergWatts = watts;
  $('erg-watts').value = watts;
  store.set('spinquest.profile', profile);
  sfx('step');
  showGear(true);
  return true;
}

/** + / − on the Click, the buttons or the keys: change gear in a free ride, or the target in ERG mode. Returns whether anything changed. */
function shiftGear(dir) {
  if (mode === 'ride' && rideMode === 'erg') return adjustErg(dir);
  if (!ctlActive || !gears || rideMode !== 'free') return false;
  if (gears.shift(dir)) { sfx('step'); showGear(true); return true; }
  return false;
}

// A double click of the Zwift Click (either button, twice within a moment) takes or cancels the extension while the turn
// point is in sight. The first press has already changed gear by then, so that shift is handed back: a double click
// leaves your gear alone.
const clicks = new DoubleClick();

/** A line under the Click's status saying what it last did, so you can tell it is talking even when no gear changes. */
function noteClick(text) {
  const status = $('dev-click').querySelector('[data-status]');
  let note = $('dev-click').querySelector('[data-note]');
  if (!note) { note = document.createElement('small'); note.dataset.note = ''; status.after(note); }
  note.textContent = text;
}
/** The Click card keeps a short log of what the Click is doing (also in the console), visible whether or not gears are on. */
const deviceLogs = {};
function makeLogger(kind, label) {
  const lines = (deviceLogs[kind] = []);
  return (text, as) => {
    console.debug(`${label}:`, text);
    if (as === 'status' && lines.at(-1)?.startsWith('receiving:')) lines.pop(); // the live line updates in place
    lines.push(text);
    if (lines.length > 22) lines.shift();
    const card = $(CARD[kind]);
    let pre = card.querySelector('[data-log]');
    if (!pre) { pre = document.createElement('pre'); pre.dataset.log = ''; pre.className = 'click-log'; card.querySelector('[data-connect]').before(pre); }
    pre.textContent = lines.join('\n');
  };
}
const logClick = makeLogger('click', 'Zwift Click');
const logTrainer = makeLogger('trainer', 'Trainer');
function onClickFrame(hex) { console.debug('Zwift Click frame (not a button press we know):', hex); noteClick(t('Click sent something unfamiliar: {hex}', { hex })); }
let lastWhy = -9999;
/** Why a press did nothing, once in a while, so the rider isn't left guessing. */
function explainNoGears() {
  if (mode !== 'ride' || performance.now() - lastWhy < 6000) return;
  lastWhy = performance.now();
  const why = useSim ? t('Gears need a connected trainer. You are riding with the keyboard.')
    : rideMode === 'workout' ? t('In a workout the trainer sets each interval for you.')
      : profile.control === 'off' ? t('You turned off trainer control, so gears are off too.')
        : t('SpinQuest is not controlling your trainer, so gears are off.');
  toast({ text: t('No gears this ride'), sub: why, kind: 'combo' });
}

function onClickButton(dir) {
  const step = profile.clickSwap ? -dir : dir;
  noteClick(`${t('Last press: {what}', { what: t(step > 0 ? 'harder (+)' : 'easier (−)') })}${rideMode === 'erg' ? ` · ${t('ERG target')}` : ctlActive && rideMode === 'free' ? '' : ` · ${t('no gears this ride')}`}`);
  const res = clicks.press(performance.now(), mode === 'ride' && game?.extension().state === 'approach');
  if (res.double) {
    if (res.undo) shiftGear(-res.undo);
    game.toggleExtension();
    return;
  }
  const shifted = shiftGear(step);
  if (!shifted && !(ctlActive && gears && rideMode === 'free')) explainNoGears();
  clicks.record(shifted ? step : 0);
}
$('g-up').addEventListener('click', () => shiftGear(+1));
$('g-down').addEventListener('click', () => shiftGear(-1));

/**
 * Each frame: decide what resistance to ask the trainer for.
 *  - Free ride: the road's own resistance through your virtual gear (see GearResistance). Auto-shift, if it is on, changes
 *    the gear to keep your cadence in range; it never touches the power. Terrain therefore matters.
 *  - ERG and workout modes: the trainer holds the target power, eased if your cadence falls below your range so you can't
 *    be pinned grinding.
 */
function driveTrainer(dt) {
  const c = links.trainer?.control;
  if (!ctlActive || !c) return;
  if (c.state === 'idle') c.acquire();
  const cad = hub.get('cadence') ?? 0;
  cadSmooth += (cad - cadSmooth) * (1 - Math.exp(-dt / 1.0));
  cadFast += (cad - cadFast) * (1 - Math.exp(-dt / 0.3));
  if (c.state !== 'ready') { showGear(); return; }

  let want = 0;
  if (game.finished || game.paused) want = 0;
  else if (rideMode !== 'free') want = game.target ? ergGuard(game.wo ? game.wo.watts : game.target.watts, cadFast, gears.low) : 0;
  else {
    if (gears.update(dt, cadSmooth)) { sfx('step'); showGear(true); }
    want = resist.update(dt, cad, { grade: game.grade, mass: game.mass, drag: game.user.drag });
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
  toast({ text: t('Ride saved'), sub: fit.name, kind: 'go' });
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
  rideMode = p.mode;
  const workout = rideMode === 'erg' ? ergWorkout(p.ergWatts, p.ftp) : rideMode === 'workout' ? (STRUCTURED.find((w) => w.id === p.workout) ?? STRUCTURED[0]) : WORKOUTS[0];
  useSim = !links.trainer;
  sim = new Sim(p);
  game = new Game({ profile: { ...p, name: p.name || t('You') }, workout, progress });
  game.xpAtStart = progress.xp;
  game.levelAtStart = levelFor(progress.xp);

  ctlActive = !useSim && canControl() && p.control !== 'off';
  gears = new VirtualGears({ auto: rideMode === 'free' && p.shift === 'auto', low: p.cadLow, high: p.cadHigh });
  resist = new GearResistance(gears);
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
  $('btn-mute').classList.toggle('muted', isMuted());
  $('btn-mute').setAttribute('aria-pressed', String(isMuted()));
});
addEventListener('beforeunload', () => { saveProgress(); links.trainer?.control?.release(); });

// ---- keys: shifting with a trainer, power with the simulator ---------------------------------------

addEventListener('keydown', (e) => {
  if (mode !== 'ride') return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (ctlActive || rideMode === 'erg') {
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

// ---- language ---------------------------------------------------------------------------------------
// setLang() re-translates the static page; the menu text that JS writes is rebuilt here. Connected devices stay connected.

const langButtons = document.querySelectorAll('[data-lang]');
const markLang = () => langButtons.forEach((b) => { const on = b.dataset.lang === getLang(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
langButtons.forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
markLang();
onLangChange(() => {
  markLang();
  if (!bluetoothSupported()) showBtWarning();
  fillWorkouts();
  showHrLimits();
  for (const kind of KINDS) {
    const card = $(CARD[kind]);
    if (card.statusFn) card.querySelector('[data-status]').textContent = card.statusFn();
    card.querySelector('[data-connect]').textContent = t(card.btnState === 'connected' ? 'Disconnect' : 'Connect');
    const rc = card.querySelector('[data-reconnect]');
    if (rc.dataset.name) rc.textContent = t('Reconnect {name}', { name: rc.dataset.name });
  }
  updateControlUi();
  refreshMenu();
});

// graphics quality
$('quality').value = renderer.quality;
$('quality').addEventListener('change', () => renderer.applyQuality($('quality').value));

// build the 3D world behind a loading screen, then start the loop
(async function init() {
  const bar = $('loader-bar'), text = $('loader-text');
  try {
    await renderer.build((p, label) => { bar.style.width = `${Math.round(p * 100)}%`; text.textContent = t(label); });
  } catch (err) {
    console.error(err);
    text.textContent = t("Couldn't start the game graphics");
    const e = $('loader-error');
    e.hidden = false;
    e.textContent = t('Use an up-to-date Chrome, Edge, Safari or Firefox, and make sure hardware acceleration is on. (Details: {msg})', { msg: err.message || err });
    return;
  }
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 800);
  last = performance.now();
  requestAnimationFrame(frame);
})();
