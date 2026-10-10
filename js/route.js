// Where a rider is on the course. The loop has two forks (see SPURS in course.js): Valley Road leaves it at the foot of
// the climb and rejoins after the descent; Death Road leaves it late in the lap and comes back onto it at the start line.
// Every rider carries
//   c      the course coordinate (see course.js): [0, LOOP) on the loop, a detour's own range while on it
//   spur   true while on a detour (which one is spurAt(c))
//   laps   how many times they have crossed the start line (can be -1 for riders who start behind it)
//   since  metres ridden since the last fork or rejoin, and `last` what that was ('enter' | 'exit' | 'pass')
//   lastSpur  which detour that was about
// `x` (the odometer) keeps counting every metre ridden; `c` is where those metres actually are.

import { LOOP, SPURS, spurAt } from './course.js';

const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

/** Put a rider at odometer position x on the main loop (bots and remote riders always stay on it). */
export function placeOnLoop(r, x) {
  r.c = wrap(x);
  r.spur = false;
  r.laps = Math.floor(x / LOOP);
  r.since = Infinity;
  r.last = null;
  r.lastSpur = null;
  return r;
}

/** The first fork strictly ahead of loop position c, or null if the start line comes first. */
const nextFork = (c) => SPURS.find((s) => s.fork > c) ?? null;

/**
 * Move a rider dx >= 0 metres along the road. `take(spur)` is asked each time they reach a fork and says whether to ride
 * that detour. Returns the events on the way: 'enter' | 'exit' | 'pass' (a fork), and 'lap' (the start line).
 */
export function advance(r, dx, take = () => false) {
  const events = [];
  let left = dx;
  r.since += dx;
  for (let guard = 0; left > 0 && guard < 12; guard++) {
    if (r.spur) {
      const sp = SPURS[spurAt(r.c)];
      const toEnd = sp.end - r.c;
      if (left < toEnd) { r.c += left; left = 0; } else {
        left -= toEnd; r.spur = false;
        r.c = sp.rejoin;
        if (r.c >= LOOP) { r.c -= LOOP; r.laps++; events.push('exit', 'lap'); } else events.push('exit');
        r.last = 'exit'; r.lastSpur = sp.index; r.since = left;
      }
      continue;
    }
    const fork = nextFork(r.c);
    const toStop = fork ? fork.fork - r.c : LOOP - r.c;
    if (left < toStop) { r.c += left; left = 0; continue; }
    left -= toStop;
    if (fork) {
      r.c = fork.fork;
      const kind = take(fork) ? 'enter' : 'pass';
      if (kind === 'enter') { r.spur = true; r.c = fork.base; }
      events.push(kind); r.last = kind; r.lastSpur = fork.index; r.since = left;
    } else {
      r.c = 0; r.laps++;
      events.push('lap');
    }
  }
  return events;
}

/**
 * The course coordinate `delta` metres of road ahead of (+) or behind (-) a rider, following their route. Used to place
 * things that live at an odometer distance from the rider: their coach, the orbs in front of them, the camera.
 * `intent` says whether a fork still to come will be taken.
 */
export function courseAt(r, delta, intent = false) {
  if (delta >= 0) {
    const copy = { c: r.c, spur: r.spur, laps: r.laps, since: r.since, last: r.last, lastSpur: r.lastSpur };
    advance(copy, delta, () => intent);
    return copy.c;
  }
  const back = -delta;
  if (back <= r.since || !r.last) {
    const c = r.c - back;
    return r.spur ? Math.max(SPURS[spurAt(r.c)].base, c) : wrap(c);
  }
  const rem = back - r.since;
  const sp = SPURS[r.lastSpur];
  // before the fork you were on the loop; before the rejoin, still on the detour
  return r.last === 'exit' ? Math.max(sp.base, sp.end - rem) : wrap(sp.fork - rem);
}

/**
 * A comparable position along the loop: laps ridden, and for a rider on a detour, how far along the stretch of loop it
 * replaces (the fork to the rejoin) they are, by progress.
 */
export const roadX = (r) => {
  if (!r.spur) return r.laps * LOOP + r.c;
  const sp = SPURS[spurAt(r.c)];
  return r.laps * LOOP + sp.fork + ((r.c - sp.base) / sp.len) * (sp.rejoin - sp.fork);
};

/**
 * Metres of road from `a` to `b` (+ = b is ahead). A rider on a detour is placed by progress along the stretch of loop it
 * replaces, except against another rider on the same detour, where the real distance counts.
 */
export const gapBetween = (a, b) => (a.spur && b.spur && spurAt(a.c) === spurAt(b.c) ? b.c - a.c : roadX(b) - roadX(a));

/** A rider on a detour within 20 m of where it leaves or joins the loop. */
function endsMeet(r) {
  if (!r.spur) return false;
  const sp = SPURS[spurAt(r.c)];
  return r.c - sp.base < 20 || sp.end - r.c < 20;
}

/** Whether two riders are on the same stretch of road (the loop, or the same detour), counting each fork and rejoin as both. */
export function sameStretch(a, b) {
  if (a.spur === b.spur) return !a.spur || spurAt(a.c) === spurAt(b.c) || endsMeet(a) || endsMeet(b);
  return endsMeet(a.spur ? a : b);
}
