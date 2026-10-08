// Wires devices, menu, game loop, HUD and persistence together.

import { Renderer } from './render.js';
import { Game } from './game.js';
import { Hud, toast, showSummary, drawWorkoutProfile } from './hud.js';
import { WORKOUTS } from './workouts.js';
import { Sim } from './sim.js';
import { DataHub, connectTrainer, connectHeartRate, bluetoothSupported, bluetoothProblem, explainError } from './ble.js';
import { initAudio, sfx, setMuted, isMuted } from './audio.js';
import { ACHIEVEMENTS } from './achievements.js';
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
const profile = store.get('spinquest.profile', { name: '', weight: 75, ftp: 200, maxHr: 190, workout: 'free' });
const progress = store.get('spinquest.progress', { xp: 0, rides: 0, km: 0 });
progress.ach ||= {};
progress.segPR ||= {};
const saveProgress = () => store.set('spinquest.progress', progress);

// ---- state ----------------------------------------------------------------------------

const hub = new DataHub();
const links = { trainer: null, hr: null };
const renderer = new Renderer($('scene'));
const hud = new Hud();
let mode = 'menu'; // menu | ride | summary
let game = null;
let sim = null;
let useSim = false;
let attract = null;
let attractSim = null;
let endTimer = null;
let last = performance.now();

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
  });
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
  refreshMenu();
}

function refreshMenu() {
  const p = readProfile();
  const w = WORKOUTS.find((x) => x.id === p.workout);
  $('workout-desc').textContent = w.desc;
  drawWorkoutProfile($('workout-preview'), w, p.ftp);
  const lvl = levelFor(progress.xp);
  $('m-level').textContent = `Level ${lvl}`;
  $('m-title').textContent = levelTitle(lvl);
  $('m-xpbar').style.width = `${((progress.xp - xpForLevel(lvl)) / (xpForLevel(lvl + 1) - xpForLevel(lvl))) * 100}%`;
  $('m-xp').textContent = `${progress.xp.toLocaleString()} XP · ${Object.keys(progress.ach).length}/${ACHIEVEMENTS.length} achievements`;
  const hint = links.trainer
    ? 'Set your trainer power yourself. SpinQuest only listens.'
    : 'No trainer connected: you will ride with the keyboard simulator.';
  $('start-hint').textContent = hint;
  $('start').textContent = links.trainer ? 'Start ride' : 'Start with simulator';
}
document.querySelectorAll('#menu input, #menu select').forEach((el) => el.addEventListener('input', refreshMenu));

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
    if (mode === 'ride' && ['reconnecting', 'lost', 'connected'].includes(state) && links[kind]) {
      toast({ text: kind === 'trainer' ? 'Trainer' : 'HR strap', sub: status.textContent, kind: state === 'connected' ? 'go' : 'combo' });
    }
    refreshMenu();
  };
}

for (const kind of ['trainer', 'hr']) {
  const card = $(kind === 'trainer' ? 'dev-trainer' : 'dev-hr');
  const ui = deviceUi(kind);
  card.querySelector('[data-connect]').addEventListener('click', async () => {
    if (links[kind]) { links[kind].close(); links[kind] = null; return; }
    if (!bluetoothSupported()) { ui('idle'); card.querySelector('[data-status]').textContent = bluetoothProblem(); return; }
    ui('connecting');
    try {
      const opts = { all: $('show-all').checked };
      const emit = (f) => hub.push(f);
      links[kind] = await (kind === 'trainer' ? connectTrainer : connectHeartRate)(emit, ui, opts);
    } catch (err) {
      links[kind] = null;
      ui('idle');
      console.warn('Bluetooth connect failed', err);
      card.querySelector('[data-status]').textContent = explainError(err);
    }
  });
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
  refreshMenu();
}

$('start').addEventListener('click', startRide);
$('btn-finish').addEventListener('click', endRide);
$('s-again').addEventListener('click', toMenu);
$('btn-mute').addEventListener('click', () => {
  setMuted(!isMuted());
  $('btn-mute').textContent = isMuted() ? '🔇' : '🔊';
});
addEventListener('beforeunload', saveProgress);

// ---- simulator keys ----------------------------------------------------------------------------

addEventListener('keydown', (e) => {
  if (mode !== 'ride' || !sim || !useSim) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const step = { ArrowUp: 10, ArrowDown: -10, PageUp: 50, PageDown: -50 }[e.key];
  if (step) { sim.offset += step; e.preventDefault(); }
  if (e.code === 'Space') { sim.sprint = true; e.preventDefault(); }
  if (e.key === 'm') $('btn-mute').click();
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
      attract = new Game({ profile: p, workout: WORKOUTS[0], progress: { xp: 0, ach: done, segPR: {} } });
      attractSim = new Sim(p);
    }
    attract.update(dt, attractSim.update(dt, null));
    attract.drain();
    renderer.draw(attract, dt);
  }
  requestAnimationFrame(frame);
}

fillMenu();
requestAnimationFrame(frame);
