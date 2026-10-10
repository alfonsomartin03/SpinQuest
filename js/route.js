// Where a rider is on the course. The main loop forks at the foot of the climb (JUNCTION): a rider who takes the road
// around the outside rides it and comes back onto the loop after the descent (REJOIN), skipping the climb. Every rider carries
//   c      the course coordinate (see course.js): [0, LOOP) on the loop, [LOOP, TOTAL] on the extension
//   spur   true while on the extension
//   laps   how many times they have crossed the start line (can be -1 for riders who start behind it)
//   since  metres ridden since the last turn-point event, and `last` what that event was ('enter' | 'exit' | 'pass')
// `x` (the odometer) keeps counting every metre ridden; `c` is where those metres actually are.

import { LOOP, TOTAL, JUNCTION, REJOIN, SPUR_LEN } from './course.js';

const wrap = (d) => ((d % LOOP) + LOOP) % LOOP;

/** Put a rider at odometer position x on the main loop (bots and remote riders always stay on it). */
export function placeOnLoop(r, x) {
  r.c = wrap(x);
  r.spur = false;
  r.laps = Math.floor(x / LOOP);
  r.since = Infinity;
  r.last = null;
  return r;
}

/**
 * Move a rider dx >= 0 metres along the road. `take()` is asked each time they reach the turn point and says whether to
 * go around. Returns the events on the way: 'enter' | 'exit' | 'pass' (turn point) and 'lap' (start line).
 */
export function advance(r, dx, take = () => false) {
  const events = [];
  let left = dx;
  r.since += dx;
  for (let guard = 0; left > 0 && guard < 8; guard++) {
    if (r.spur) {
      const toEnd = TOTAL - r.c;
      if (left < toEnd) { r.c += left; left = 0; } else {
        left -= toEnd; r.c = REJOIN; r.spur = false;
        events.push('exit'); r.last = 'exit'; r.since = left;
      }
    } else if (r.c < JUNCTION) {
      const toJ = JUNCTION - r.c;
      if (left < toJ) { r.c += left; left = 0; } else {
        left -= toJ; r.c = JUNCTION;
        const kind = take() ? 'enter' : 'pass';
        if (kind === 'enter') { r.spur = true; r.c = LOOP; }
        events.push(kind); r.last = kind; r.since = left;
      }
    } else {
      const toEnd = LOOP - r.c;
      if (left < toEnd) { r.c += left; left = 0; } else {
        left -= toEnd; r.c = 0; r.laps++;
        events.push('lap');
      }
    }
  }
  return events;
}

/**
 * The course coordinate `delta` metres of road ahead of (+) or behind (-) a rider, following their route. Used to place
 * things that live at an odometer distance from the rider: their coach, the orbs in front of them, the camera.
 * `intent` says whether a turn point still to come will be taken.
 */
export function courseAt(r, delta, intent = false) {
  if (delta >= 0) {
    const copy = { c: r.c, spur: r.spur, laps: r.laps, since: r.since, last: r.last };
    advance(copy, delta, () => intent);
    return copy.c;
  }
  const back = -delta;
  if (back <= r.since || !r.last) {
    const c = r.c - back;
    return r.spur ? Math.max(LOOP, c) : wrap(c);
  }
  const rem = back - r.since;
  return r.last === 'exit' ? Math.max(LOOP, TOTAL - rem) : wrap(JUNCTION - rem); // before the fork you were on the loop, before the rejoin on the road around
}

/**
 * A comparable position along the loop: laps ridden, and for a rider on the road around, how far along the stretch of
 * loop it replaces (the fork to the rejoin) they are, by progress.
 */
export const roadX = (r) => r.laps * LOOP + (r.spur ? JUNCTION + ((r.c - LOOP) / SPUR_LEN) * (REJOIN - JUNCTION) : r.c);

/**
 * Metres of road from `a` to `b` (+ = b is ahead). A rider on the road around is placed by progress along the stretch of
 * loop it replaces, except against another rider on it, where the real distance counts.
 */
export const gapBetween = (a, b) => (a.spur && b.spur ? b.c - a.c : roadX(b) - roadX(a));

/** Whether two riders are on the same stretch of road (the loop, or the road around), counting the fork and the rejoin as both. */
export function sameStretch(a, b) {
  if (a.spur === b.spur) return true;
  const out = a.spur ? a : b;
  return out.c - LOOP < 20 || TOTAL - out.c < 20;
}
