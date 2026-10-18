# starship

Working title. A deterministic, headless simulation of a procedural
starship and the crew who live aboard it. The simulation runs itself:
there are no player controls and no orders to give. The player picks a
seed and witnesses. The seed chooses the ship, the crew, and the fate,
and the event log (the ship's chronicle) records what truly happened
while the crew acted on what they believed.

Status: v0 slice. The kernel is in place and tested, and the first
living world runs on it: a procedural ship (10 to 14 rooms, seven kinds
of ship system) generated from the seed, a crew of twelve with names,
roles, traits, needs, and private beliefs about each other, and the
first incident generator: grudges incite sabotage, suspicion forms from
who was seen nearby, and accusations are spoken as beliefs, not
findings. Every run renders a chronicle, the event log as a readable
ship's log. The galaxy around the ship is not built yet. See DESIGN.md
for the full design and DECISIONS.md for the standing choices.

## Requirements

Node.js 22.18 or later. The CLI runs the TypeScript sources directly
with Node's built-in type stripping, so there is no build step.
`npm install` only adds dev tools: TypeScript, Vitest, and Node types.

```bash
npm install
```

## Running

Simulate a run. Ticks are ten ship-minutes, so 4,320 ticks is a
30-day voyage. With `--out <dir>` this also writes `events.ndjson`,
`decisions.ndjson`, `summary.json` (the summary records the event
stream hash plus elapsedMs and ticksPerSecond), and `chronicle.txt`.

```bash
npm run simulate -- --seed 42 --ticks 4320 --out runs/seed42
```

Replay a recorded run and check that it reproduces the event stream
exactly:

```bash
npm run replay -- --dir runs/seed42
```

Re-render the chronicle of a recorded run (simulate already writes
one; this regenerates it, for example after renderer changes):

```bash
npm run chronicle -- --dir runs/seed42
```

## Tests

```bash
npm test
```

The suite covers determinism (same seed, same hash; RNG stream
independence), purity (a static scan that bans wall-clock and ambient
randomness calls from the engine sources), replay (a recorded
decision log reproduces the hash; a tampered or truncated log raises a
divergence error), and the slice itself: ship and crew generation
determinism, needs and beliefs staying in bounds over long runs, the
sabotage mechanics (a strong grudge acted on; a bystander wrongly
suspected), a full-slice replay over 2,000 ticks, and a 30-day
performance sanity run. `npm run check` runs the type check and the
tests.

## Layout

- `src/sim.ts`: entry point that wires a world together (engine,
  systems in fixed order, invariant checks). CLIs and tests build
  worlds through here.
- `src/cli/`: the simulate, replay, and chronicle command line
  entries, plus tiny argument helpers. This is platform code; the
  engine never imports it.
- `src/engine/`: the fixed-order tick loop, the World shell, and the
  seeded RNG with named independent streams.
- `src/log/`: the append-only event log and its running stream hash.
- `src/decision/`: decision sources. Agents pick from candidate lists
  through these; the utility source plays live, the replay source plays
  a recorded log back and refuses to improvise.
- `src/scenario/`: configuration. Every tunable number and table lives
  in `config.ts`.
- `src/world/`: the procedural ship, its systems (condition, wear,
  strain, repair), and shipboard weather.
- `src/entities/`: the crew of twelve and their per-tick behaviour.
- `src/perception/`: beliefs: directed trust and bond, suspicion,
  grudges, and the society step that forms grudges and speaks
  accusations.
- `src/plots/`: incident generators. Currently sabotage: how a grudge
  becomes an act, and how the crew forms suspicion from presence
  evidence afterwards.
- `test/`: the test suites, at the package root like the reference
  layout.
- `viewer/`: the browser viewer (own tsconfig, esbuild bundle, static
  server), a separate layer over the same engine. See the Viewer
  section below.

## Viewer

The viewer is a separate layer that runs the same engine in the
browser, mirroring how the reference project separates its viewer from
its simulation. It lives under `viewer/`, imports the engine from
`src/`, and changes no engine code paths: a run is driven through the
stepper API in `src/sim.ts` (`createRun`, then `step()` per tick),
which the batch CLI also uses.

```bash
npm run viewer
```

Then open http://localhost:5176. The seed rides in the URL —
http://localhost:5176/?seed=42 opens that voyage directly, and the URL
updates when a new voyage starts — so a link can carry a specific ship
to a phone. The page is mobile-first and touch-friendly: a top-down
deck plan of the ship with the crew walking its rooms (see "The ship"
below), a live crew panel with need bars (tap a name to highlight that
person on the deck and in the chronicle), the space-weather banner,
and the chronicle streaming in ship time with a highlights-only filter
on by default.

Playback mirrors the reference viewer's controls: a Play/Pause button,
the Space key, and speed keys 1 to 6 (with matching on-screen buttons).
Speeds are 1x = one tick every 2.5 seconds (the slow witness pace),
2x = 1 tick/sec, 3x = 3 ticks/sec, 4x = 8 ticks/sec, 5x = 20 ticks/sec,
6x = 60 ticks/sec. The header shows the ship's name, the Day and
ship-clock, the current speed, and the live event-stream hash, so
determinism stays visible. Two choices keep long 1x sessions smooth:
a frame advances at most 5 ticks and discards any larger backlog (a
slept phone resumes gently, never burst-simulating), and the chronicle
keeps at most 300 line elements in the DOM while the full rendered log
stays in memory.

**Voyage of the Day.** Mirroring the reference project's "Battle of
the day", the viewer carries a curated list of seven vetted seeds
(`viewer/src/daily.ts`) and rotates through it by UTC day: everyone
who opens the daily voyage on the same day gets the same ship. A
banner chip in the header names today's ship when you are sailing it,
and offers a "★ Today's voyage" button when you are not. Opening the
viewer with `?daily=1` starts today's seed directly (it takes
precedence over `?seed=`), with a toast naming the ship. The seeds
were vetted for drama by full 30-day runs (see DECISIONS.md); the
rotation is a viewer-layer choice only, and the engine never sees a
clock.

For link publishing, `npm run viewer:static` writes a single
self-contained page at `viewer/dist-static/index.html` with the bundle
inlined. Build outputs (`viewer/dist/`, `viewer/dist-static/`) are not
committed.

## The ship

The schematic of boxes is gone. The viewer now draws the ship as a
top-down deck you can walk through with your eyes: an elongated hull
(tapered bow, engine block at the stern, blinking navigation lights,
a starfield behind it) holding two bands of rooms along a central
corridor. The floor plan is a deterministic derivation from the
ship the engine generated: room sizes come from room kinds,
engineering pins the stern and the bridge the bow, the remaining
rooms chain by adjacency in the ship's own room graph, and doors
pierce shared walls between neighbouring rooms and open onto the
corridor. The same ship always yields the same deck; the engine
knows nothing about it.

Every room is dressed as itself, in code: consoles and the captain's
chair on the bridge, a reactor core and machine blocks in
engineering, beds in the medbay, tables and a serving counter in the
mess, bunks in quarters, plant racks in hydroponics, crates and
barrels in cargo, benches and tanks in the lab, mats in the gym,
hazard stripes in the airlock. Floors differ by kind (grating, pale
tile, soil green, checker, carpet, concrete). A room that hosts a
ship system shows that system's equipment, with its name and live
condition at the room's edge. All of it is painted from string-grid
sprites and hash arithmetic in `viewer/src/props.ts` and
`viewer/src/deck.ts`; there are no image assets.

The crew are little 8x12 bodies in department colours, their heads
carrying the same skin and hair as their panel portraits. They walk
door to door between rooms at a pace matched to the tick, stand at
the equipment when they work (the botanist at the racks, the cook at
the counter, an engineer at the system their last work event names),
and repairs throw small blue-white welding sparks from the worker's
hands. The ship feels alive and shows its hurts: console lights
blink, the reactor core and the stern engines glow with a brightness
scaled by system condition, hydroponics racks shimmer under a light
sweep, the bridge screen runs a slow radar sweep, and a room whose
system drops below 60% flickers and throws orange damage sparks
(below 30%: faster sparks and a blinking red warning lamp) until it
is repaired. Thought and speech bubbles appear over crew, Sims-style,
always from real state: a critical need, an active grudge, a strong
suspicion, an accusation spoken aloud, or crewmates in conversation.

Performance follows the faces pattern: the whole deck (hull, floors,
walls, props) is pre-rendered once per ship to an offscreen canvas,
and each frame draws that image, the dynamic light and spark layer
(particles capped at 200), the bodies, and the labels.

The ship travels through a living sky. Behind the hull hangs a
procedural backdrop generated from the voyage's own seed
(`viewer/src/space.ts`): soft nebula clouds in a restrained seeded
palette (two hues per voyage from deep teal, violet, ember, rose,
and ice blue, always darker than the ship, so the deck stays the
subject) and three star layers drifting past at parallax speeds,
far stars crawling, near stars sliding, the brightest few wearing
a cross sparkle. The drift scales with playback speed; paused, it
slows to a twentieth of the slowest sail instead of stopping, so
space breathes even at anchor. Every seed sails a slightly
different sector of space.

The ship also keeps a day. The viewer reads the ship's clock as
light (`viewer/src/daynight.ts`): the day watch is fully lit, the
evening (19:00-22:00) dims through warm amber to about half, the
night watch (22:00-06:00) sits at about 40% brightness under a
cool blue tint, and dawn (06:00-07:00) warms back up, all ramped
smoothly over the boundary hours. The tint is a translucent fill
over the deck; everything that emits light (equipment blink
lights, the reactor and engine glow, navigation lights, sparks,
the radar sweep, system labels and condition bars) is drawn above
it, so a night ship reads as a lit ship in dark space. Crew bodies
dim less than the rooms (to 82% at the darkest), and resting crew
lie down on their bunks, so at 03:00 the ship is visibly asleep
except for the watch-standers at their lit consoles. A small sun
or moon beside the clock names the watch. The engine does not act
on any of this yet; the engine analog (a night watch leaves fewer
awake witnesses, thinning the evidence behind suspicion) is
recorded as design-future in DECISIONS.md.

## Faces

The crew are not dots. Following the reference viewer's pattern, each
person's face is a pure function of their crew id: an integer hash with
one salt per feature picks the skin tone (7 tones), hair colour (8),
hair style (short, long, bun, shaved, wavy, swept), eye colour, face
shape, facial hair, and a distinguishing mark (a mole, freckles, or
none), and the uniform is painted in their department's colour
(Command gold, Engineering orange, Medical white, Science blue,
Operations red, Services green). There is no stored appearance data
and no image asset: the same id always yields the same face. The
portrait is painted pixel by pixel on a 16x16 canvas in
`viewer/src/faces.ts`, cached per person, and repainted only when the
state that shows on it changes.

Live state is painted over that stable identity at draw time, so the
face doubles as a status display: the mouth follows morale (content,
neutral, unhappy, miserable), low energy bags and half-closes the
eyes, and holding an active grudge furrows the brow. The overlay hook
is where future state (bandages, scars, a grey cast for the dead) will
plug in when the simulation grows injuries.

On the deck, each person is a small body whose head carries the
portrait's skin and hair and whose torso carries the department
colour, so a figure across the ship matches the face in the panel.
Tapping a crew member, in the panel or on the deck,
opens a person card: the large portrait, a prose bio
composed from the same hash-derived appearance plus the clauses live
state has earned (tired, hungry, lonely, holding a grudge, suspected),
a dossier (need bars, closest relationships with bond and trust, held
grudges, suspicions held and received), and a RECENT list of that
person's own last events as chronicle sentences. The viewer invents
nothing but the look and the prose glue; every fact is sim state.
