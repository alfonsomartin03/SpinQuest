// Turns a finished ride into a .fit activity for Strava, Garmin Connect, TrainingPeaks and the like.
//
// The virtual course is laid over a made-up spot on the map, in open ocean so it can never collide with a real ride, a
// real segment or a real heatmap. The route is the course itself, projected onto the globe at true scale, so the
// distance, elevation and every bend in the file are the ones the rider rode. The file declares itself a virtual
// activity (not a GPS ride), so platforms file it as a Virtual Ride.

import { posAt, elevation, gradeAt, START, MAP } from './course.js';
import { FitWriter, toFitTime } from './fit.js';

/** Two spots with no road within hundreds of kilometres. */
export const PLACES = [
  { id: 'nemo', name: 'Point Nemo', note: 'the loneliest place on Earth', lat: -48.8767, lon: -123.3933 },
  { id: 'bermuda', name: 'The Bermuda Triangle', note: 'try not to vanish', lat: 25.0, lon: -71.0 },
];

export const pickPlace = (rand = Math.random) => PLACES[Math.floor(rand() * PLACES.length)];

const EARTH_R = 6371008.8; // m; the mean radius haversine distance uses
const DEG = 180 / Math.PI;
const SEMI = 2 ** 31 / 180; // degrees -> FIT semicircles
export const MIN_SECONDS = 10; // shorter rides are not worth uploading

/** Maps a distance along the course to a latitude/longitude with the loop centred on `place`. */
export function projector(place) {
  const cx = (MAP.minX + MAP.maxX) / 2;
  const cy = (MAP.minY + MAP.maxY) / 2;
  const kLat = DEG / EARTH_R;
  const kLon = DEG / (EARTH_R * Math.cos(place.lat / DEG));
  return (d) => {
    const p = posAt(START + d); // x = east, y = north, in metres
    return { lat: place.lat + (p.y - cy) * kLat, lon: place.lon + (p.x - cx) * kLon };
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * @param {{samples:{p,hr,cad,v,d}[], startedAt:number, place:object}} ride  one sample per second of riding
 * @returns {Uint8Array} the bytes of a .fit file
 */
export function buildFit({ samples, startedAt, place }) {
  const where = projector(place);
  const t0 = toFitTime(startedAt);
  const n = samples.length;
  const semi = (deg) => Math.round(deg * SEMI);
  const altCode = (m) => Math.round((m + 500) * 5);

  const rows = samples.map((s, i) => {
    const pos = where(s.d);
    return {
      t: t0 + i + 1, lat: semi(pos.lat), lon: semi(pos.lon), alt: altCode(elevation(START + s.d)), hr: s.hr, cad: s.cad,
      dist: Math.round(s.d * 100), speed: Math.round(s.v * 1000), power: Math.round(s.p), grade: Math.round(gradeAt(START + s.d) * 10000),
    };
  });
  let ascent = 0, descent = 0;
  for (let i = 1; i < n; i++) {
    const dz = (rows[i].alt - rows[i - 1].alt) / 5;
    if (dz > 0) ascent += dz; else descent -= dz;
  }
  const hrs = samples.map((s) => s.hr).filter((h) => h > 0);
  const cads = samples.map((s) => s.cad).filter((c) => c > 0);
  const watts = samples.map((s) => Math.round(s.p));
  const dist = samples[n - 1].d; // metres since the start line
  const first = rows[0];
  const end = t0 + n;

  const w = new FitWriter();
  // file_id (0): type=activity, manufacturer=development, product, serial, created
  w.define(0, 0, [[0, 'enum'], [1, 'uint16'], [2, 'uint16'], [3, 'uint32z'], [4, 'uint32']]);
  w.data(0, [4, 255, 0, (startedAt % 0xfffffff) + 1, t0]);
  // device_info (23)
  w.define(1, 23, [[253, 'uint32'], [0, 'uint8'], [2, 'uint16'], [4, 'uint16']]);
  w.data(1, [t0, 0, 255, 0]);
  // sport (12): cycling / virtual activity
  w.define(2, 12, [[0, 'enum'], [1, 'enum']]);
  w.data(2, [2, 58]);
  // event (21): timer start
  w.define(3, 21, [[253, 'uint32'], [0, 'enum'], [1, 'enum']]);
  w.data(3, [t0, 0, 0]);

  // record (20)
  const rec = [[253, 'uint32'], [0, 'sint32'], [1, 'sint32'], [2, 'uint16'], [5, 'uint32'], [6, 'uint16'], [7, 'uint16'], [9, 'sint16'], [4, 'uint8']];
  if (hrs.length) rec.push([3, 'uint8']);
  w.define(4, 20, rec);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const vals = [r.t, r.lat, r.lon, r.alt, r.dist, r.speed, r.power, r.grade, r.cad > 0 ? Math.round(r.cad) : null];
    if (hrs.length) vals.push(r.hr > 0 ? Math.round(r.hr) : null);
    w.data(4, vals);
  }

  w.data(3, [end, 0, 4]); // timer stop (all)

  // lap (19)
  w.define(5, 19, [[253, 'uint32'], [0, 'enum'], [1, 'enum'], [2, 'uint32'], [3, 'sint32'], [4, 'sint32'], [7, 'uint32'], [8, 'uint32'], [9, 'uint32']]);
  w.data(5, [end, 9, 1, t0, first.lat, first.lon, n * 1000, n * 1000, dist * 100]);

  // session (18)
  w.define(6, 18, [
    [253, 'uint32'], [0, 'enum'], [1, 'enum'], [2, 'uint32'], [3, 'sint32'], [4, 'sint32'], [5, 'enum'], [6, 'enum'],
    [7, 'uint32'], [8, 'uint32'], [9, 'uint32'], [11, 'uint16'], [14, 'uint16'], [15, 'uint16'], [16, 'uint8'], [17, 'uint8'],
    [18, 'uint8'], [19, 'uint8'], [20, 'uint16'], [21, 'uint16'], [22, 'uint16'], [23, 'uint16'], [25, 'uint16'], [26, 'uint16'],
  ]);
  w.data(6, [
    end, 8, 1, t0, first.lat, first.lon, 2, 58,
    n * 1000, n * 1000, dist * 100, watts.reduce((a, b) => a + b, 0) / 1000 / 0.24 / 4.184, // kcal at ~24% efficiency
    (dist / n) * 1000, Math.max(...samples.map((s) => s.v)) * 1000, mean(hrs), hrs.length ? Math.max(...hrs) : null,
    mean(cads), cads.length ? Math.max(...cads) : null, mean(watts), Math.max(...watts), ascent, descent, 0, 1,
  ]);

  // activity (34)
  w.define(7, 34, [[253, 'uint32'], [0, 'uint32'], [1, 'uint16'], [2, 'enum'], [3, 'enum'], [4, 'enum'], [5, 'uint32']]);
  w.data(7, [end, n * 1000, 1, 0, 26, 1, end]);

  return w.finish();
}

/** A file name like SpinQuest-2026-10-09-1432.fit (local time of the start). */
export function fitFileName(startedAt) {
  const d = new Date(startedAt);
  const p = (x) => String(x).padStart(2, '0');
  return `SpinQuest-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.fit`;
}
