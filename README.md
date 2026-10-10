# IndoorTrainer
Cycling Indoor Training App

# SpinQuest

A game layer for indoor cycling. Connect your smart trainer (or power meter) and heart-rate strap over Bluetooth, pick a workout, and ride a looping virtual world that reacts to your live numbers. SpinQuest never uploads anything itself; you can download your ride as a `.fit` file (see below) or record it on another device. It only controls the trainer's resistance if you let it (see below).

## Run

```bash
python3 serve.py          # http://localhost:8000
```

Open it in **Chrome or Edge** (Safari and Firefox have no Web Bluetooth). No build step and no dependencies. Click **Start with simulator** to try it without hardware.

Your trainer must allow a second Bluetooth connection (most modern FTMS trainers allow 2-3). Connect your recording device or head unit first if yours is strict. ANT+ is not supported.

## How it plays

- **A 10 km loop with 7 zones.** Sunny Meadow, Pine Forest, a snowy Alpine Pass (with a rock tunnel and a cheering summit crowd), Orchard Descent, Blue Lake (covered bridge, lighthouse, sailboats), Old Village (market, church, crowds) and Golden Fields. The road really climbs about 200 m to the pass and bends with the map. Time of day follows the course, from bright morning to golden hour at the lake.
- **A fork at the foot of the climb.** Where the Col de SpinQuest begins the road forks. From a kilometre out a banner offers **Valley Road**: about 8.8 km of flat, open road that swings around the east and north of the mountain and rejoins the loop after the descent, so you skip the climb (the lap becomes about 13 km instead of 10). Go around with the banner's button, the `E` key, or by **double-clicking your Zwift Click** (either button, twice within about half a second; the first press's gear change is handed back, so your gear is untouched). Do nothing and you ride up the Col; the choice is made fresh each lap. The bunch behind you follows you around, the minimap and elevation strip switch to Valley Road while you are on it, and the summary counts the times you went around. It has its own zone, two landmarks and kilometre markers, and its own achievement.
- **14 landmarks to discover.** Ride past each one for the first time to earn +100 points (two of them are on Valley Road). The minimap and elevation strip show them as `?` until you find them. Click the minimap to zoom in and follow your rider.
- **A real 3D world (Three.js).** A chase camera follows your rider through a procedurally generated landscape: terrain that hugs the road and rises into snow-capped mountains, a lake with sailboats and reeds, a stream under a covered wooden bridge, a lit rock tunnel, pine forests, orchards, a village and golden wheat fields. Time of day follows the course, from bright morning on the climb to golden hour at the lake. Every model and texture is generated in code, so there are no art files to load or license.
- **Characters with personality.** Every rider is a rigged, stylised cyclist with smooth tapered limbs, a patterned jersey with a race number on the back, bib shorts, socks and shoes, an aero helmet, sunglasses and their own skin tone and hair (some have bobbing ponytails). The bikes have aero tubes, deep-section wheels, a bottle and a blinking rear light. Legs and arms follow the real pedal position, wheels turn at the right speed, riders lean into bends, and yours stands out of the saddle when you sprint.
- **Rider sidebar.** Everyone on the road is listed Zwift-style with watts, W/kg, speed and a time gap, ordered by position with you highlighted. Click a rider for a card with their speed, cadence, heart rate, FTP, weight and gap (Esc closes it). The bunch are simulated riders with their own weights, FTPs and plausible heart rates.
- **Climb panel.** Approaching and on the Col de SpinQuest you get distance left, climbing left, the average grade left, the grade now and over the next 500 m, VAM, estimated time to the top, the summit altitude and the steepest section ahead, over a grade-coloured profile with your position on it.
- **A sober course map.** Survey grid, a route coloured by gradient, kilometre markers, direction arrows, vector landmark badges (hollow until discovered), segment bands, the lake, a scale bar and a north arrow. Click it to zoom and follow.
- **Reactive effects.** Your aura takes your power-zone colour, sprints throw sparks and blur the edges of the screen, the screen edges glow in your heart-rate zone and pulse with each beat, and snow falls on the pass.
- **Stop pedalling and the ride stops.** After a second of coasting the rider brakes to a halt (even downhill), and after 3 seconds without pedalling the clock, workout and scoring pause until you pedal again.
- **Power drives speed.** Real cycling physics (gradient, rolling resistance, air drag, drafting) moves you around the loop. Climbs slow you down, descents speed you up, and there is no speed limit: on the steep descent a heavy rider can coast past 80 km/h while a light one cannot. Drag area grows with weight but slower than weight itself, and riders tuck on descents, so weight helps downhill and hurts uphill.
- **The world reacts.** Your aura takes your power-zone colour, sprints throw sparks, and the screen edges glow in your heart-rate zone and pulse with your actual heartbeat. The sky moves through a day and night cycle.
- **Custom heart-rate zones.** Open "Heart-rate zones" under Rider in the menu to set the upper limit of each zone in bpm (from a lab test, field test or your watch). Until you change a number the zones follow Max HR (60, 70, 80 and 90%); "Reset" goes back to that.
- **Zwift Click shifter.** Connect a Zwift Click from the menu and its right button shifts virtual gears harder and its left button easier (a "Swap buttons" option flips them). Gears only change in a ride that uses cadence control. A double click also chooses to go around the climb when the fork is near (see above). The original Click is supported; the newer encrypted Click v2 / Zwift Ride controllers are not. Put the Click in pairing mode (press a button) and make sure Zwift or another app is not already connected to it.
- **Workouts.** Structured sessions (sweet spot, threshold, VO2, sprints, pyramid, ...) show a target and a profile graph with your power drawn over it. A gold **Coach** rides the target power, so stay on their wheel. Hold the target to build a combo multiplier (x1 to x5).
- **The pack.** Six bots ride the loop with their own pacing and attacks. Sit in their draft for a speed boost (the Drafting badge shows when it is on).
- **Orbs and segments.** Collect orb arcs on the road. Ride three timed segments (a climb, a flat sprint, a downhill dash) against the pack and chase your PRs.
- **Progression.** Points become XP, levels and achievements, saved in your browser (`localStorage`).

Simulator controls: `↑`/`↓` ±10 W, `PgUp`/`PgDn` ±50 W, hold `Space` to sprint, `P` toggles "stop pedalling", `M` mutes.

## Export a ride (.fit)

When a ride ends, the summary screen offers **Download .fit** (also on the menu until you start another ride). Upload the file to Strava, Garmin Connect, TrainingPeaks, intervals.icu and similar.

- **Spoofed location, on purpose.** The course (loop and Valley Road) is laid over the Bermuda Triangle, in open ocean. No road is anywhere near, so it can't touch a real segment, KOM or heatmap.
- **True to the ride.** The route is the virtual course projected at real scale, so the file's distance, elevation, grade and every bend match what you rode (`test/export.test.mjs` checks the geodesic length, altitude and headings). One record per second of riding: power, heart rate, cadence, speed, distance, altitude, grade, position.
- **Honest about being virtual.** The sport is set to cycling / virtual activity, so Strava files it as a Virtual Ride. The altitudes are the course's (1,178 to 1,374 m) wherever it is placed.
- **Never stored.** The file exists only in memory. It is gone when you close the tab or start another ride; nothing is written to disk, `localStorage` or a server unless you download it.

## Trainer control (virtual gears)

With a **Zwift Cog** (or any trainer left in one fixed gear) cadence doesn't feel natural by itself: climbing would just grind. SpinQuest can ask the trainer for resistance over the standard FTMS control point:

- **Cadence control** (default): the goal is to hold your cadence at the **middle of your comfortable range** (default 80 to 100 rpm, so 90, set in the menu), whatever power you are making. It predicts where your cadence is heading: there is a padding zone around the middle where the bike can accelerate and decelerate naturally, and toward either end of your range the push-back grows exponentially, so it responds fast before you leave the range. A slow term learns the power you are really holding, the terrain never feeds back into resistance (your power decides how fast you move in the world, not the other way round), and a "virtual flywheel" term resists sudden changes in cadence. The request is smoothed and rate-limited, firms up a little outside the range, and eases off quickly if you sag below it, so you can't lock up, grind or spin out. Your gear (24 gears, 50 t ring, 11 to 40 t cogs) sets the starting resistance. Shift with `←` `→` (or `,` `.`) or the + and − buttons, or leave **auto-shift** on (it shifts easier after about 3 seconds below your range and harder after about 2 seconds above it, only when that brings you closer to it, and it leaves sprints alone). Manual shifts pause auto-shift for 8 seconds.
- **ERG**: the trainer holds each workout interval's power for you. A guard eases the target if your cadence falls below your range, so ERG can't pin you. Free rides still use cadence control.
- **Listen only**: you control resistance yourself (use this with a real cassette, because virtual gears would stack on top of the real ones).

The controller's gains were tuned in a closed-loop simulation (a rider, a flywheel and an ERG-style trainer with lag and noisy cadence), and `test/control.test.mjs` keeps that behaviour honest, including a test that the old power-for-cadence target let cadence settle below the range. Resistance is handed back (0 W, stop, reset) when the ride ends. If another app already controls the trainer, SpinQuest says so and falls back to listening only. This needs an FTMS trainer that supports power targets; power meters can't be controlled.

## Pairing

The pairing list is filtered to trainers, power meters and heart-rate straps (by Bluetooth service and common brand names), and the heart-rate list hides trainers. After the first pairing, Chrome versions with persistent Bluetooth permissions show a **Reconnect <name>** button that skips the list entirely. If your device isn't listed, use **Search all devices**.

## Graphics

Pick **Low / Medium / High / Ultra** in the menu. The default is chosen from your GPU (Apple, NVIDIA and recent AMD or Intel Arc get High, other integrated graphics get Medium, software rendering gets Low). The picture also adapts its resolution on the fly to hold a steady frame rate. It runs at 60 fps on an Apple M1 at High. Needs a browser with WebGL 2 (current Chrome, Edge, Safari or Firefox).

## Multiplayer groundwork

There is no server yet, but the pieces that make remote riders possible are in place and tested (`js/net.js`):

- **One rider shape.** You, the bunch, the coach and remote players all share the same fields (id, name, colour, position, speed, power, cadence, heart rate, weight, FTP), so the sidebar, the 3D scene and the network code treat them alike. `game.allRiders()`, `game.applyRemote(state)` and `game.removeRemote(id)` add and remove players on the fly.
- **Wire format.** A small versioned JSON state sent about 10 times a second. Incoming states are validated and clamped, so a bad client can't inject NaNs or teleport. A real server should also check plausibility (speed against power) before relaying.
- **Smooth remote motion.** Each remote rider is drawn about 150 ms in the past and interpolated between packets, with a brief extrapolation if one is late, and the sender's clock is estimated so jitter doesn't show.
- **Try it.** Open `http://localhost:8000/?demo=remote` to ride with three simulated live riders arriving over a fake network with 90 ms latency and jitter. They appear in the sidebar with a cyan dot and in the 3D world.

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
  js/hud.js             HUD: sidebar, rider card, climb panel, graphs, toasts, summary
  js/hudviz.js          map, climb profile and elevation strip drawing
  js/net.js             multiplayer groundwork: wire format, smoothing, loopback
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
