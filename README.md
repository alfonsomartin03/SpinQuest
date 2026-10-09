# IndoorTrainer
Cycling Indoor Training App

# SpinQuest

A game layer for indoor cycling. Connect your smart trainer (or power meter) and heart-rate strap over Bluetooth, pick a workout, and ride a looping virtual world that reacts to your live numbers. You record the activity on another device. SpinQuest never spoofs a location or uploads anything, and it only controls the trainer's resistance if you let it (see below).

## Run

```bash
python3 serve.py          # http://localhost:8000
```

Open it in **Chrome or Edge** (Safari and Firefox have no Web Bluetooth). No build step and no dependencies. Click **Start with simulator** to try it without hardware.

Your trainer must allow a second Bluetooth connection (most modern FTMS trainers allow 2-3). Connect your recording device or head unit first if yours is strict. ANT+ is not supported.

## How it plays

- **A 10 km loop with 7 zones.** Sunny Meadow, Pine Forest, a snowy Alpine Pass (with a rock tunnel and a cheering summit crowd), Orchard Descent, Blue Lake (covered bridge, lighthouse, sailboats), Old Village (market, church, crowds) and Golden Fields. The road really climbs about 200 m to the pass and bends with the map. Time of day follows the course, from bright morning to golden hour at the lake.
- **12 landmarks to discover.** Ride past each one for the first time to earn +100 points. The minimap and elevation strip show them as `?` until you find them. Click the minimap to zoom in and follow your rider.
- **A real 3D world (Three.js).** A chase camera follows your rider through a procedurally generated landscape: terrain that hugs the road and rises into snow-capped mountains, a lake with sailboats and reeds, a stream under a covered wooden bridge, a lit rock tunnel, pine forests, orchards, a village and golden wheat fields. Time of day follows the course, from bright morning on the climb to golden hour at the lake. Every model and texture is generated in code, so there are no art files to load or license.
- **Characters with personality.** Every rider is a rigged, stylised cyclist with smooth tapered limbs, a patterned jersey with a race number on the back, bib shorts, socks and shoes, an aero helmet, sunglasses and their own skin tone and hair (some have bobbing ponytails). The bikes have aero tubes, deep-section wheels, a bottle and a blinking rear light. Legs and arms follow the real pedal position, wheels turn at the right speed, riders lean into bends, and yours stands out of the saddle when you sprint.
- **Reactive effects.** Your aura takes your power-zone colour, sprints throw sparks and blur the edges of the screen, the screen edges glow in your heart-rate zone and pulse with each beat, and snow falls on the pass.
- **Stop pedalling and the ride stops.** After a second of coasting the rider brakes to a halt (even downhill), and after 3 seconds without pedalling the clock, workout and scoring pause until you pedal again.
- **Power drives speed.** Real cycling physics (gradient, drag, drafting) moves you around a 9 km loop of rolling hills. Climbs slow you down, descents speed you up.
- **The world reacts.** Your aura takes your power-zone colour, sprints throw sparks, and the screen edges glow in your heart-rate zone and pulse with your actual heartbeat. The sky moves through a day and night cycle.
- **Workouts.** Structured sessions (sweet spot, threshold, VO2, sprints, pyramid, ...) show a target and a profile graph with your power drawn over it. A gold **Coach** rides the target power, so stay on their wheel. Hold the target to build a combo multiplier (x1 to x5).
- **The pack.** Six bots ride the loop with their own pacing and attacks. Sit in their draft for a speed boost (the Drafting badge shows when it is on).
- **Orbs and segments.** Collect orb arcs on the road. Ride three timed segments (a climb, a flat sprint, a downhill dash) against the pack and chase your PRs.
- **Progression.** Points become XP, levels and achievements, saved in your browser (`localStorage`).

Simulator controls: `↑`/`↓` ±10 W, `PgUp`/`PgDn` ±50 W, hold `Space` to sprint, `P` toggles "stop pedalling", `M` mutes.

## Trainer control (virtual gears)

With a **Zwift Cog** (or any trainer left in one fixed gear) cadence doesn't feel natural by itself: climbing would just grind. SpinQuest can ask the trainer for resistance over the standard FTMS control point:

- **Virtual gears** (default): speed = cadence x gear ratio, and the trainer is asked for the watts that speed needs on the current gradient (and in a draft). Spin faster or pick a harder gear and it pushes back; hit a climb and you shift down to keep your rpm. There are 24 gears (50 t ring, 11 to 40 t cogs). Shift with `←` `→` (or `,` `.`) or the + and − buttons. **Auto-shift** uses *your* comfortable cadence range (default 80 to 100 rpm, set in the menu): it shifts easier after about 3 seconds below the low number and harder after about 2 seconds above the high one. It only shifts if the new gear brings you closer to your range, and it leaves all-out sprints alone. Manual shifts pause auto-shift for 8 seconds.
- **ERG**: the trainer holds each workout interval's power for you. Free rides still use virtual gears.
- **Listen only**: you control resistance yourself (use this with a real cassette, because virtual gears would stack on top of the real ones).

Resistance is handed back (0 W, stop, reset) when the ride ends. If another app already controls the trainer, SpinQuest says so and falls back to listening only. This needs an FTMS trainer that supports power targets; power meters can't be controlled.

## Pairing

The pairing list is filtered to trainers, power meters and heart-rate straps (by Bluetooth service and common brand names), and the heart-rate list hides trainers. After the first pairing, Chrome versions with persistent Bluetooth permissions show a **Reconnect <name>** button that skips the list entirely. If your device isn't listed, use **Search all devices**.

## Graphics

Pick **Low / Medium / High / Ultra** in the menu. The default is chosen from your GPU (Apple, NVIDIA and recent AMD or Intel Arc get High, other integrated graphics get Medium, software rendering gets Low). The picture also adapts its resolution on the fly to hold a steady frame rate. It runs at 60 fps on an Apple M1 at High. Needs a browser with WebGL 2 (current Chrome, Edge, Safari or Firefox).

## Supported devices

| Device | Bluetooth service |
|---|---|
| Smart trainers | Fitness Machine (FTMS) Indoor Bike Data |
| Power meters | Cycling Power (power + cadence from crank revolutions) |
| HR straps / watches in broadcast mode | Heart Rate |

If a device doesn't show up, tick "Show all Bluetooth devices" in the menu.

## Tests

```bash
node --test test/*.test.mjs
```

Covers the Bluetooth packet parsers, physics, course, workouts and the game rules.

## Layout

```
IndoorTrainer/
  index.html, style.css, serve.py
  vendor/three/         Three.js r170 (MIT), vendored so the app runs offline
  js/main.js            wiring, menu, persistence, trainer control loop
  js/course.js          the 10 km loop: map, elevation, zones, landmarks, segments
  js/game.js            rules: bots, drafting, orbs, segments, combos
  js/physics.js, gearing.js, workouts.js, achievements.js, sim.js, audio.js
  js/ble.js             Web Bluetooth, packet parsers, FTMS control point
  js/hud.js             HUD, minimap, graphs, toasts, summary
  js/world/
    scene3d.js          the renderer: camera, lighting, post-processing, quality
    terrain.js          heightfield, lake, stream, tunnel cutting, colours
    road.js, structures.js   road ribbon, markings, signs, tunnel, covered bridge
    flora.js            trees, grass, flowers, wheat, houses (instanced, chunked)
    landmarks.js        windmills, castle, lighthouse, church, crowds, gantries
    riders.js           rigged cyclist model and name tags
    sky.js, water.js, effects.js, textures.js, geo.js, noise.js
  test/                 unit and world-geometry tests
```
