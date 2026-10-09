# IndoorTrainer
Cycling Indoor Training App

# SpinQuest

A game layer for indoor cycling. Connect your smart trainer (or power meter) and heart-rate strap over Bluetooth, pick a workout, and ride a looping virtual world that reacts to your live numbers. You set the power on your trainer or head unit yourself, and you record the activity on another device. SpinQuest only listens, so it never controls the trainer, spoofs a location or uploads anything.

## Run

```bash
python3 serve.py          # http://localhost:8000
```

Open it in **Chrome or Edge** (Safari and Firefox have no Web Bluetooth). No build step and no dependencies. Click **Start with simulator** to try it without hardware.

Your trainer must allow a second Bluetooth connection (most modern FTMS trainers allow 2-3). Connect your recording device or head unit first if yours is strict. ANT+ is not supported.

## How it plays

- **A 10 km loop with 7 zones.** Sunny Meadow, Pine Forest, a snowy Alpine Pass (with a rock tunnel and a cheering summit crowd), Orchard Descent, Blue Lake (covered bridge, lighthouse, sailboats), Old Village (market, church, crowds) and Golden Fields. The road really climbs about 200 m to the pass and bends with the map. Time of day follows the course, from bright morning to golden hour at the lake.
- **12 landmarks to discover.** Ride past each one for the first time to earn +100 points. The minimap and elevation strip show them as `?` until you find them. Click the minimap to zoom in and follow your rider.
- **Third-person view.** A chase camera sits behind your rider on a winding road. You see the pack ahead from behind, the road rises and falls with the course, and the sky runs through a day and night cycle.
- **Power drives speed.** Real cycling physics (gradient, drag, drafting) moves you around a 9 km loop of rolling hills. Climbs slow you down, descents speed you up.
- **The world reacts.** Your aura takes your power-zone colour, sprints throw sparks, and the screen edges glow in your heart-rate zone and pulse with your actual heartbeat. The sky moves through a day and night cycle.
- **Workouts.** Structured sessions (sweet spot, threshold, VO2, sprints, pyramid, ...) show a target and a profile graph with your power drawn over it. A gold **Coach** rides the target power, so stay on their wheel. Hold the target to build a combo multiplier (x1 to x5).
- **The pack.** Six bots ride the loop with their own pacing and attacks. Sit in their draft for a speed boost (the Drafting badge shows when it is on).
- **Orbs and segments.** Collect orb arcs on the road. Ride three timed segments (a climb, a flat sprint, a downhill dash) against the pack and chase your PRs.
- **Progression.** Points become XP, levels and achievements, saved in your browser (`localStorage`).
- Auto-pause: stop pedalling for 5 s and the timers and workout pause.

Simulator controls: `↑`/`↓` ±10 W, `PgUp`/`PgDn` ±50 W, hold `Space` to sprint, `M` mutes.

## Supported devices

| Device | Bluetooth service |
|---|---|
| Smart trainers | Fitness Machine (FTMS) Indoor Bike Data |
| Power meters | Cycling Power (power + cadence from crank revolutions) |
| HR straps / watches in broadcast mode | Heart Rate |

If a device doesn't show up, tick "Show all Bluetooth devices" in the menu.

## Tests

```bash
node --test test/units.test.mjs
```

Covers the Bluetooth packet parsers, physics, course, workouts and the game rules.

## Layout

```
IndoorTrainer/
  index.html, style.css, serve.py
  js/ble.js          Web Bluetooth + packet parsers
  js/physics.js      speed model, course, zones, levels
  js/game.js         rules: bots, drafting, orbs, segments, combos
  js/workouts.js     workout library
  js/achievements.js
  js/render.js       canvas world and effects
  js/hud.js          HUD, graphs, toasts, summary
  js/sim.js          keyboard simulator
  js/main.js         wiring, menu, persistence
```
