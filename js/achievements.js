// Achievements are checked once a second against the live game state.

import { LANDMARKS } from './course.js';

export const ACHIEVEMENTS = [
  { id: 'first-spin', name: 'First Spin', desc: 'Pedal for a full minute', test: (g) => g.t >= 60 },
  { id: 'warmed-up', name: 'Warmed Up', desc: 'Ride for 10 minutes', test: (g) => g.t >= 600 },
  { id: 'hour', name: 'Hour of Power', desc: 'Ride for a full hour', test: (g) => g.t >= 3600 },
  { id: 'zone-dweller', name: 'Zone Dweller', desc: '10 minutes in Endurance power', test: (g) => g.zonePow[1] >= 600 },
  { id: 'threshold', name: 'Threshold Tamer', desc: '5 minutes at Threshold power', test: (g) => g.zonePow[3] >= 300 },
  { id: 'redline', name: 'Redline', desc: '1 minute in heart-rate zone 5', test: (g) => g.zoneHr[4] >= 60 },
  { id: 'sprinter', name: 'Sprinter', desc: 'Hold 2.2x FTP for 5 seconds', test: (g) => g.maxP5 >= 2.2 * g.profile.ftp },
  { id: 'slipstream', name: 'Slipstream Surfer', desc: '2 minutes drafting behind riders', test: (g) => g.draftTime >= 120 },
  { id: 'orbs', name: 'Orb Collector', desc: 'Collect 250 orbs in one ride', test: (g) => g.orbCount >= 250 },
  { id: 'slayer', name: 'Segment Slayer', desc: 'Win a segment against the pack', test: (g) => g.segWins >= 1 },
  { id: 'dialed-in', name: 'Dialed In', desc: 'Nail an interval (90%+ on target)', test: (g) => g.perfectIntervals >= 1 },
  { id: 'max-combo', name: 'Max Combo', desc: 'Reach the x5 multiplier', test: (g) => g.mult >= 5 },
  { id: 'twenty', name: 'Twenty Club', desc: 'Ride 20 km in one go', test: (g) => g.distance >= 20000 },
  { id: 'summit', name: 'Summit Seeker', desc: 'Reach the top of the pass', test: (g) => !!g.progress.discovered.summit },
  { id: 'explorer', name: 'Explorer', desc: 'Discover every landmark', test: (g) => Object.keys(g.progress.discovered).length >= LANDMARKS.length },
  { id: 'extra-mile', name: 'Long Way Round', desc: 'Ride the flat road around the climb', test: (g) => g.spurDone >= 1 },
];
