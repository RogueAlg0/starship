# starship

Working title. A deterministic, headless simulation of a procedural
starship and the crew who live aboard it. The simulation runs itself:
there are no player controls and no orders to give. The player picks a
seed and witnesses. The seed chooses the ship, the crew, and the fate,
and the event log (the ship's chronicle) records what truly happened
while the crew acted on what they believed.

The crew keeps the Ship's Routine. Every member sails on one of two
watches (a day watch, and a night watch of two drawn by role: one
engineering hand, one bridge or security hand) with a daily shape of
sleep, work blocks, meals, and free time, nudged by traits. The awake
ship eats together at two meal windows a day, seated at tables of up
to four; the chronicle prints one line per sitting, plus the
occasional notable pairing. Rumour travels only between people who
were actually together: a strongly held suspicion can pass at table
or in shared free time, capped by the teller's own level and by the
listener's accusation threshold, and the chronicle speaks only when
gossip tips someone to the edge of accusing. Free time has its own
texture: table games with a winner, exercise in the gym, reading in
quarters. The viewer's person card names each member's watch and
current block.

Status: v0 slice. The kernel is in place and tested, and the first
living world runs on it: a procedural ship (10 to 14 rooms, seven kinds
of ship system) generated from the seed, a crew of twelve with names,
roles, traits, needs, and private beliefs about each other, and the
first incident generator: grudges incite sabotage, suspicion forms from
who was seen nearby, and accusations are spoken as beliefs, not
findings. Every run renders a chronicle, the event log as a readable
ship's log. The galaxy's first layer is built: each seed generates a
sector of named ports and factions, and the voyage is an itinerary
across it: a chartered first leg, then port calls and further legs,
each port with its own character. The ship lives off her stores —
food, water, oxygen margin, fuel, spare parts — produced by her
systems, consumed by her crew and her engines, and refilled by
what each port can give. The sector is not empty: other ships fly
fixed schedules across it, and the ones that pass within sensor
range are met as contacts in the log, named on the chart, and
glimpsed from the hull. See DESIGN.md for the full design and
DECISIONS.md for the standing choices.

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
divergence error), the slice itself: ship and crew generation
determinism, needs and beliefs staying in bounds over long runs, the
sabotage mechanics (a strong grudge acted on; a bystander wrongly
suspected), a full-slice replay over 2,000 ticks, and a 30-day
performance sanity run, and the galaxy: sector generation
determinism and bounds (port counts, separations, faction home
ports), the charter leg's distance-and-speed arithmetic, a monotonic
route, an arrival that fires exactly once on its named tick for every
daily seed, the itinerary (legs and stays chained, stay lengths bent
by port character, no sailing straight back when the band offers an
alternative, arrivals in a 90-day run matched leg for leg against
the table), traffic: schedule determinism and sanity, position
purity, constructed contact cases, and a contact ledger re-derived
from the position functions alone and matched against the event
stream, and stores: production as rate times condition, rationed
consumption, resupply capped by port character and never above
capacity, rationing's trigger and lift hysteresis and its
trait-bent trigger, theft accounting that reconciles to the
milli-unit, a fuel-empty drift that slows the voyage clock but
can never strand the ship, and quantities inside their tanks over
90-day runs on several seeds. `npm run check` runs the type check
and the tests.

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
  strain, repair), shipboard weather, the ship's stores (five
  stores in days of supply, the port call, rationing, and theft),
  and the galaxy: the procedural sector (ports and factions), the
  voyage itinerary across it, and the sector's traffic: other ships
  on schedules generated at build, whose positions are pure
  functions of the tick.
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
and the chronicle streaming in ship time. The chronicle opens in
Highlights mode (meals, games, bonds, grudges, accusations,
incidents, weather turns) with the full log one toggle away; the
choice rides in the URL (`?log=full`) and is remembered. A thin
ship's day ribbon under the header names the watch phase, the
block most of the crew are in, and the next beat of the day, and
the deck stages the routine itself: crew sit at the mess tables to
eat and to play, travellers on errands carry a tool case or a
stores crate, the gym's mats fill at exercise time, and a reader
sits with a book open.

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

**Alerts.** News floats over the deck's top-right corner as compact
chips (on narrow phones the stack runs full-width above the deck
instead), tiered by urgency like the reference squad viewer's battle
news. Critical alerts (red) are states: a system below 30% condition,
or failed, stays up while the condition holds, and its dismiss button
snoozes it only until the condition changes band. Major alerts
(amber) are moments — sabotage found, an accusation, a grudge, a
system crossing below 60% — and linger about 12 seconds; minor
alerts (neutral) carry the quiet good news (a repair finished, a
system back above 90%, a bond formed) and fade in about 5. Lifetimes
scale mildly with playback speed (see DECISIONS.md), the stack holds
at most four with one alert per subject, and tapping a chip goes to
what it names: the person, or the room, which flashes on its deck.

**The feel pass.** Borrowing the reference squad viewer's central
trick — every event is re-staged in the world at the moment it is
shown — the deck now acts out its news (`viewer/src/staging.ts`). A
sabotage flashes wrong at the culprit's system for the witness (in
fiction, nobody saw it); a system that fails bursts sparks and
vents vapour; a finished repair rings green; a radiation storm
strobes the navigation lights as it arrives. A system in its worst
band telegraphs its end first: irregular coughing spark bursts, a
fast-strobing warning lamp, a wisp of smoke. And the frame itself
flinches: staged blows shake the deck, harder for a failure than a
sabotage, muffled when the trouble is on the other deck, and never
at all under prefers-reduced-motion.

**Performance.** The frame loop follows the reference viewers'
discipline: the chronicle appends as one batched DOM write per
drain, the crew pass uses pre-tinted cached body sprites instead
of a canvas filter, glow gradients are built once per layout, the
wear layer is composited into the static deck so a frame blits
one base canvas, scratch structures are reused rather than
allocated, and a paused voyage redraws the deck at about 15 fps.

**The cutaway.** The Decks view shows both deck plans in one
frame, stacked with a structural gap, each plate-labelled DECK 1
and DECK 2: there is no deck switching, and a crewmate riding the
lift between decks is simply in the other plan. Every pass (wear,
light, systems, bodies, bubbles, staged events) runs per deck in
its own coordinates; the movement underneath is one shared system,
so the crew's staging is untouched by there being two plans on the
canvas. The canvas scales in whole multiples to fill the stage, so
the ship is as large as the screen allows at a crisp pixel scale.
Keys 7 and 8 still move the focus deck (the minimap's frame, and
which deck's shake the scene takes); the minimap tap does the same.

**The hull exterior.** A second view (the Hull button, or key
9) steps outside to a side profile of the same ship against the
same sky, her compartment windows lit by who is awake inside, the
mess glowing warm at table, damage scorching the hull at the hurt
system's station, and a tap on the hull returning to its deck.

**The star map.** A third view (the Chart button, or key 0 or M)
opens the sector chart: the seed's ports as named points in their
factions' colours (a ring for a faction home port, plain grey for
an independent), the chartered route dashed across the grid, and
the ship as a marker walking the itinerary, the sailed part of
the current leg drawn solid. The header names the current leg
(port → port, days out, days to go) or the port being lived in
("In port at <name> · day N of M · sails <day, time>"), the
marker wears a docked ring while she lies in port, and tapping a
port opens its card: faction, character, and its distance from
the ship right now, in light-days and in days at cruise. The
chart's static layer paints once per voyage; per frame only the
marker and pulses move.

**Stores and port calls.** A strip under the weather banner
carries the five stores as slim bars in days of supply, with a
trend arrow from the standing net flow and bands that match the
alert tiers; stores news (a store running low or critical,
rationing imposed) arrives through the same alert stack as
everything else, and a tap goes to the quartermaster or the
store's producing system. In port the manifest, the shore-leave
rotations, and the harbour news print in the chronicle as
highlights; crew ashore are absent from the deck and the
minimap, marked "Ashore" on the roster, with the person card
reading "Ashore at <port>".

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

The ship has two decks. Deck 1 (upper) holds the bridge, quarters,
mess, medbay, and lab. Deck 2 (lower) holds engineering, cargo,
hydroponics, the airlock, and the gym. Each deck keeps the same
generator language: two bands of rooms along its own corridor,
inside the one hull footprint, and a deck shorter than the hull
pads the difference with tanks and pipe runs in the plating. Two
lift shafts at fixed points along the corridor are the only way
between decks: crew walk to a lift, fade into the car, and appear
at the same shaft on the other deck. The main canvas shows one deck
at a time (buttons or keys 7 and 8 switch), while a minimap under
it shows both decks at once: room blocks, crew as department-colour
dots, the lifts as gold ticks, and a pulsing outline on any room
whose worst system is hurting. Tap a deck on the minimap, or tap a
crew member who is on the other deck, and the view follows. The
engine has no floors; the decks are presentation of the room graph,
recorded in DECISIONS.md.

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
is repaired. Thought and speech bubbles appear over crew,
always from real state: a critical need, an active grudge, a strong
suspicion, an accusation spoken aloud, or crewmates in conversation.

The ship also keeps its scars (`viewer/src/wear.ts`). Each system
wears its history on the deck around its equipment: scorch blotches,
floor scuffs, grime streaks, and, at clear damage, a panel knocked
askew. The marks scale with both the system's current condition and
the worst condition it has reached this run, so a system repaired
back to health keeps most of its scorch: getting hurt leaves a mark
that getting fixed does not erase. When a system that fell below 60%
is brought back above 80%, the repair leaves a permanent patch beside
the equipment, a lighter plate with rivets and a weld-bead edge on
scrubbed floor, one per damage and repair cycle. The hull wears too:
scorch and pitting at the engine block scale with the engines' worst
condition, and a faint exhaust stain grows slowly with elapsed ticks
and caps low, so the ship ages under way. Wear is tracked in the
viewer from the frame stream, painted into an offscreen layer that
repaints only when a wear input crosses a bucket boundary (condition
in 5% bands, a new worst low, a new patch, a five-day age step), and
drawn with the static deck, under the day/night tint.

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
