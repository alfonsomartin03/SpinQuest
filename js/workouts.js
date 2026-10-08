// Structured workouts. Targets are % of FTP; the rider sets the power on their own
// trainer and the game shows (and rewards) how well they hold it.

const step = (dur, from, to = from, label = '') => ({ dur, from, to, label });

function repeat(n, ...steps) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(...steps.map((s) => ({ ...s })));
  return out;
}

const warm = (min = 5) => step(min * 60, 0.45, 0.65, 'Warm up');
const cool = (min = 5) => step(min * 60, 0.6, 0.4, 'Cool down');

export const WORKOUTS = [
  { id: 'free', name: 'Free Ride', desc: 'No targets. Ride how you like and chase the pack, orbs and segments.', steps: [] },
  {
    id: 'easy', name: 'Easy Spin (30 min)', desc: 'Recovery legs. Keep it light and relaxed.',
    steps: [warm(5), step(20 * 60, 0.5, 0.55, 'Easy spin'), cool(5)],
  },
  {
    id: 'endurance', name: 'Endurance (60 min)', desc: 'Steady aerobic base work in the Endurance zone.',
    steps: [warm(8), step(44 * 60, 0.68, 0.7, 'Endurance'), cool(8)],
  },
  {
    id: 'sweetspot', name: 'Sweet Spot 3 x 8', desc: 'Three 8 minute blocks just under threshold.',
    steps: [warm(10), ...repeat(3, step(8 * 60, 0.9, 0.9, 'Sweet spot'), step(3 * 60, 0.5, 0.5, 'Recover')), cool(7)],
  },
  {
    id: 'threshold', name: 'Threshold 2 x 15', desc: 'Two long blocks right at FTP.',
    steps: [warm(10), step(15 * 60, 1.0, 1.0, 'Threshold'), step(5 * 60, 0.5, 0.5, 'Recover'), step(15 * 60, 1.0, 1.0, 'Threshold'), cool(8)],
  },
  {
    id: 'vo2', name: 'VO2 Max 5 x 3', desc: 'Five hard 3 minute efforts with equal rest.',
    steps: [warm(10), ...repeat(5, step(3 * 60, 1.15, 1.15, 'VO2 effort'), step(3 * 60, 0.45, 0.45, 'Recover')), cool(5)],
  },
  {
    id: 'sprints', name: 'Sprints 8 x 20s', desc: 'All-out 20 second sprints with long recoveries.',
    steps: [warm(10), ...repeat(8, step(20, 2.0, 2.0, 'SPRINT!'), step(160, 0.45, 0.45, 'Recover')), cool(5)],
  },
  {
    id: 'pyramid', name: 'Ramp Pyramid (45 min)', desc: 'Climb the power steps up and back down.',
    steps: [
      warm(8),
      step(120, 0.7), step(120, 0.8), step(120, 0.9), step(120, 1.0), step(120, 1.1),
      step(120, 1.0), step(120, 0.9), step(120, 0.8), step(120, 0.7),
      step(240, 0.5, 0.5, 'Recover'), cool(5),
    ],
  },
  {
    id: 'quick', name: 'Quick Test (6 min)', desc: 'Short session to try everything out.',
    steps: [step(60, 0.5, 0.6, 'Warm up'), step(60, 0.9, 0.9, 'Hard'), step(30, 0.5, 0.5, 'Recover'),
      step(60, 1.1, 1.1, 'Harder'), step(60, 0.5, 0.5, 'Recover'), step(30, 1.5, 1.5, 'Sprint!'), step(60, 0.4, 0.4, 'Cool down')],
  },
];

export const totalDuration = (w) => w.steps.reduce((a, s) => a + s.dur, 0);

/** Where are we `t` seconds into workout `w`? */
export function workoutAt(w, t, ftp) {
  let start = 0;
  for (let i = 0; i < w.steps.length; i++) {
    const s = w.steps[i];
    if (t < start + s.dur) {
      const el = t - start;
      const pct = s.from + (s.to - s.from) * (el / s.dur);
      return { idx: i, step: s, elapsed: el, remaining: s.dur - el, pct, watts: Math.round(pct * ftp), next: w.steps[i + 1] || null, done: false };
    }
    start += s.dur;
  }
  const last = w.steps[w.steps.length - 1];
  return { idx: w.steps.length, step: last, elapsed: last.dur, remaining: 0, pct: last.to, watts: Math.round(last.to * ftp), next: null, done: true };
}
