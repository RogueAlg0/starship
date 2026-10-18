# Decisions

Standing choices for this project, with the reason for each. New choices
get an entry here when they are made.

## Clean-room implementation

The design pattern is learned from a public reference project
(shaykashif/dunya), but every line of code here is original. The
reference has no license file, so its code is not ours to reuse.
Nothing is copied, nothing is published, and nothing is sent upstream
without a fresh decision at that time.

## No player controls

The simulation runs itself. The player picks a seed and witnesses; there
are no controls, orders, or interventions. The product is the chronicle:
the event log records what truly happened while the crew acted on what
they believed, and the drama lives in that gap.

## Determinism contract

A run is its seed plus its config. The engine is a fixed-order tick
loop and the only writer of world state. All randomness comes from
named, per-subsystem RNG streams, so a new draw in one system never
shifts another system's future. Every state change is appended to an
event log folded into a stream hash, and every agent decision is
recorded, so any run replays exactly from its decision log and a
mismatch is an error, not a shrug. Purity is enforced by a static scan
in the test suite, not by convention.

## Speed is a requirement

Every run reports its ticks per second. The reference class is roughly
400 ticks per second for a heavy village simulation; this kernel's
scaffold world measures in the tens of thousands. A change that makes
runs crawl is a regression, not a tradeoff.

## Folder structure mirrors the reference

The package layout (cli, engine, log, decision, scenario, world,
entities, sim.ts, tests at the root) follows the reference project's
village package, so skills and reading habits transfer both ways.

## Local-only repository

The git repository is local only, with no remote. It stays private
until there is something real and a fresh decision says otherwise.

## Ten-minute ticks (v0 slice, Oct 18, 2026)

Ship time runs at ten minutes per tick, 144 ticks to a ship day, the
village scale from the reference design. A 30-day voyage is 4,320 ticks
and runs in about a second. Finer time can be layered onto incidents
later; the daily rhythm of meals, rest, and work reads correctly at
this grain.

## Crew of twelve (v0 slice)

The crew is fixed at twelve, one per role (captain through
quartermaster), generated on the "crewgen" stream: names, traits, and
seeded pairwise beliefs, including a few directed rivalries with a head
start toward grudges. Twelve is personal: every name in the chronicle
recurs often enough to be remembered. The ship itself is procedural
(10 to 14 rooms, spanning tree plus loops, every system kind guaranteed
aboard) on the "shipgen" stream.

## Grudges incite sabotage (first incident generator)

The first drama engine is the one the design named: trust that falls
below -0.5 and stays there for twelve ship-hours becomes a grudge; a
grudge-holder alone in a room with a ship system may sabotage it, with
temperament gating the act (bold and hot-tempered raise it, disciplined
lowers it). Suspicion after an act is formed from presence evidence,
who was seen near the room in the surrounding ticks, weighted by the
observer's prior distrust, so a bystander can be suspected wrongly and
an accusation is a belief spoken aloud, never a finding. Grudges ease
if trust recovers, suspicion fades over days, and striking back spends
some of a grudge's heat: the system needs its negative feedback, or
every long run ends in a ship-wide feud (early tuning did exactly
that).

## The viewer is a separate layer (Oct 18, 2026)

The browser viewer lives under `viewer/` (its own tsconfig, an esbuild
bundle, a small static server on port 5176) and imports the engine from
`src/` unchanged, like the reference project's viewer. To drive a run
incrementally, `src/sim.ts` gained a stepper API (`createRun` /
`step()`), and the batch `runSimulation` is implemented on top of it;
the refactor is proven bit-identical by the seed-42 gate: hash
cf1dffaeb4796f91 over 4,320 ticks before and after, with the event and
chronicle files byte-identical. The chronicle renderer was split the
same way: one implementation renders a finished log at once for the
CLI and streams line by line for the viewer.

Playback mirrors the reference viewer's scheme: speeds 1 to 6, with
1x as the slow witness pace (one tick every 2.5 seconds) up to 60
ticks per second at 6x, Space to pause, the seed in the URL. The
viewer is built for long, slow sessions on a phone: a frame advances
at most 5 ticks and discards any larger backlog, so a tab that slept
for hours resumes gently instead of burst-simulating its absence; and
the chronicle keeps at most 300 line elements in the DOM (the full
rendered log stays in memory as text) so hours of streaming stay
smooth.

## Faces are a pure function of the crew id (Oct 18, 2026)

The viewer gives every crew member a procedural face, following the
reference viewer's pattern: identity is derived from an integer hash
of the crew id, one salt per feature (skin, hair colour and style,
eyes, face shape, facial hair, marks, height and build for the prose),
with zero stored appearance data and zero image assets. The same id
has the same face in every run and every viewer, for free. Uniforms
carry the group layer the reference gets from household and side
colours: a department colour per role (Command, Engineering, Medical,
Science, Operations, Services).

Identity and state are split. The face's unchanging layer is painted
once and cached per person, keyed by id plus a state signature; live
state is painted over it at draw time (expression from morale, tired
eyes from low energy, a furrowed brow from an active grudge) through
one overlay hook, which is where injury and death overlays will plug
in when the simulation grows a body model. A face is repainted only
when its state signature changes, so frame cost stays at one cached
canvas per person.

The person card follows the reference panel's three layers: a prose
bio composed from the hash-derived appearance words plus clauses the
live state has earned, a structured dossier (needs, relationships
with bond and trust, grudges, suspicions), and the person's own
recent events rendered through the chronicle. The viewer invents
nothing but the look and the prose glue.

## Voyage of the Day (Oct 18, 2026)

The viewer offers one featured voyage per day, mirroring the
reference project's "Battle of the day". A curated list of seven
vetted seeds lives in the viewer layer (`viewer/src/daily.ts`), and
the day's seed is `DAILY_SEEDS[Math.floor(Date.now() / 86_400_000) %
7]`: whole UTC days since the epoch, modulo the list. The wall clock
exists only in that one viewer function; a daily voyage is an
ordinary run of an ordinary seed, and the engine's purity rules are
untouched (the seed-42 gate still hashes cf1dffaeb4796f91). Opening
the viewer with `?daily=1` starts today's seed, taking precedence
over `?seed=`; starting any hand-picked seed clears the flag, so a
reload never silently swaps a chosen ship for today's.

The list is curated, not computed, because a dud day would poison
the ritual. Vetting: 30-day voyages (4,320 ticks) for seeds 1 to 40,
scored by drama (grudges and sabotages weighted 2, accusations 1).
The counter was verified against every previously known run before
the sweep was trusted: seed 42 (1 grudge, 2 sabotages, 5
accusations), seed 99 (2, 2, 6), seeds 1 and 2 (all zero), seeds 3
and 7 (1 grudge, 1 sabotage) all matched exactly. Twelve of the
forty seeds scored zero and were rejected as duds. So were the three
runaway cascades (seed 21 at score 992, seed 35 at 952, seed 6 at
143, with accusations in the hundreds): that is the ship-wide feud
failure mode the negative feedback exists to prevent, and at
highlights pace the chronicle becomes an accusation firehose, not a
story. The chosen seven are the high, bounded band, each with a
different ship and a different shape of trouble:

- 11: Meridian Verge, 12 rooms, 1 grudge, 2 sabotages, 1 accusation (7)
- 16: Ostara Signal, 10 rooms, 2 grudges, 3 sabotages, 2 accusations (12)
- 17: Cobalt Compass, 12 rooms, 2 grudges, 4 sabotages, 46 accusations (58)
- 30: Vela Theorem, 14 rooms, 1 grudge, 2 sabotages, 0 accusations (6)
- 39: Juniper Garden, 10 rooms, 1 grudge, 2 sabotages, 2 accusations (8)
- 40: Vela Drift, 10 rooms, 2 grudges, 3 sabotages, 5 accusations (15)
- 42: Keel Harbour, 13 rooms, 1 grudge, 2 sabotages, 5 accusations (11)

Seed 42 is in by right, not by score: it is the flagship story. Seed
30 is the quiet knife (damage done, suspicion never spoken aloud);
seed 17 is the stormy day, an accusation-rich feud that stays
bounded. For 2026-10-18 UTC, epoch day 20,744 gives index 3, so
today's voyage is seed 30, the Vela Theorem.

## The deck is a viewer-layer derivation (Oct 18, 2026)

The viewer draws the ship as a top-down deck (rooms along a central
corridor inside a tapered hull), replacing the SVG box schematic.
The floor plan is derived in the viewer from the ship data the
engine already exposes (rooms, kinds, adjacency, systems with
condition), by deterministic hash arithmetic keyed on the ship's
own signature: the same ship always yields the same deck, and the
engine is unchanged (the seed-42 hash gate still reads
cf1dffaeb4796f91). All art is code, in the faces tradition: string
grids and palettes for props and crew bodies, hash arithmetic for
floors, lights, and placement; no image assets. Damage is shown,
not just numbered: a room whose worst system falls below 60%
flickers and throws orange sparks from the system's equipment, and
below 30% adds a blinking red warning lamp, keyed live to system
condition. Working crew stand at the relevant equipment (a work
event names the system; a repair reads the member's live
repairTarget) and repairs throw blue-white welding sparks, a
different colour from damage. Thought and speech bubbles are drawn
only from real state and events (critical needs, grudges,
suspicions, accusations, co-located socializing). Static interiors
are pre-rendered once per ship; per-frame work is the dynamic
layer, bodies, and labels, with particles capped at 200.

## Construction and refit recorded (Oct 18, 2026)

At the user's direction on Oct 18, 2026: DESIGN.md gains a
"Construction and refit (future, engine system)" section. The civ
sim's villagers build their village; our long-form analog is
engineers building raw frame sections into finished rooms over
long legs, and refits at ports. Future/post-v0 design only; no
code was written for it.

## Living space, and the ship's night (Oct 18, 2026)

The viewer gained a moving space backdrop and a day/night cycle,
both presentation of facts it already holds, both viewer-only, the
engine untouched (the seed-42 gate still reads cf1dffaeb4796f91).

The backdrop (`viewer/src/space.ts`) is generated per voyage from
the ship's seed key, the same hash arithmetic the deck derivation
uses: three star layers at parallax drift speeds (far 0.7, mid
2.2, near 6.5 px/s at drift factor 1, the factor 0.45 + sqrt of
the playback ticks per second, and 0.05 when paused, so space
breathes at anchor), a few bright stars with cross sparkles, and
soft radial nebula clouds in a seeded pair of palettes from a
curated set (deep teal, violet, ember, rose, ice blue), kept low
saturation and darker than the ship so the deck stays the subject.
The old static starfield in the deck render is gone; there is one
backdrop, and it moves.

Day and night (`viewer/src/daynight.ts`) is the ship's clock read
as light: day watch (07:00-19:00) full brightness; evening ramp
(19:00-22:00) dimming through warm amber; night watch (22:00-06:00)
at 40% brightness (tint alpha 0.6 toward a cool blue); dawn ramp
(06:00-07:00) warming back; all smoothstepped over the boundary
hours. The render order carries the decision: backdrop, deck, tint,
then everything emissive above the tint (equipment lights, reactor
and engine glow, navigation lights, sparks, the radar sweep, labels
and condition bars), near stars above the tint too, and crew bodies
drawn after the tint under a mild brightness filter (0.82 at the
darkest). Resting crew are drawn horizontal on the bunks and medbay
beds of the room the engine already has them resting in; nothing
about their position is invented, only the posture. A sun/moon
pixel icon and the watch name sit beside the header clock.

Crew movement also gained easing in the same pass: per-person
velocity, acceleration 42 tiles/s^2 (braking 1.7x that), and a
cruise scaled down over the last 1.5 tiles of a walk, so crew set
off and arrive instead of halting dead at full pace.

Recorded as engine-future, not built: in the reference village
sim, light is engine state; at night fewer villagers are awake to
witness a crime and notice chances drop. Our analog is that the
night watch should thin the presence evidence behind suspicion:
fewer awake witnesses, emptier corridors, weaker almost-seeing.
DESIGN.md carries the note (Ship's night, in the world list).

## The ship keeps its scars (Oct 18, 2026)

The faces set the doctrine: a portrait is a wound report, identity
painted once and live state painted over it. The ship follows the
same rule (`viewer/src/wear.ts`). Viewer-only; the engine is
untouched (the seed-42 gate still reads cf1dffaeb4796f91).

Wear keys off the worst condition observed this run, not only the
current one. Effective damage is the worse of current damage and
80% of worst-ever damage, read in four bands: invisible above about
85% condition, faint down to 60%, clear down to 30%, heavy below.
The decals are procedural, seeded by the ship signature and the
system id, placed at the system's anchor equipment: scorch
blotches, floor scuffs, grime streaks down a wall, and a panel
knocked askew at clear damage and worse, with debris at heavy. A
repair does not launder history: when a system that fell below 60%
climbs back above 80%, a repair patch is stamped beside its anchor
(a lighter plate with rivet dots and a weld-bead edge, on floor
scrubbed clean), one patch per damage and repair cycle, permanent
for the run. The hull carries the engines' record: scorch and
pitting at the engine block scale with the engines' worst observed
condition, and exhaust staining on the stern plating grows slowly
with elapsed ticks, capped faint, so age shows without ever
shouting.

Nothing is invented and nothing is stored in the engine. The
tracks (current and worst condition, hurt flag, patch count, per
system) live in the viewer, derived from the frame stream, and
die with the page. Rendering holds the perf rule: an offscreen
layer repainted only when a bucketed input changes, drawn as one
image with the static deck under the day/night tint, while sparks
and glows stay above both.

## Future systems recorded (Oct 18, 2026)

At the user's direction on Oct 18, 2026, DESIGN.md gains a
"Getting around, and getting word around (future, engine notes)"
section, in the same future area as Construction and refit: EVA
spacewalks (external systems repaired by a suited crew member
moving slowly, tethered, along the hull; maneuvering as the
tension, the analog of the squad sim's slow march), distance
costing real ticks (where crew stand when something fails decides
how late help arrives), and communications and runners (the comms
system as the instant channel; with comms damaged, word travels by
runner at walking speed and by voice range; between ships, signals
take days and stale information is the galaxy's normal state).
Also recorded the same day, in its own DESIGN.md section: away
missions, episodic landing-party ground missions on a procedural
map with the real roster, the squad sim's slow positional movement,
destruction the map remembers, sensor beliefs that can be wrong,
and consequences that flow back aboard; a major future engine
system (a ground layer on the same kernel). Future engine design
only; no code was written for any of it.

## Two decks, lifts, and a minimap (Oct 18, 2026)

The viewer splits the ship into two decks, the way the squad sim's
buildings have floors the viewer peels between. The split is by
room kind, fixed in a table in `viewer/src/deck.ts`: Deck 1 (upper)
takes bridge, quarters, mess, medbay, and lab; Deck 2 (lower) takes
engineering, cargo, hydroponics, airlock, and gym. A kind the table
does not name goes to the deck with more spare width, ties broken
by hash, so a future room kind still lands somewhere deterministic.
Each deck is laid out by the existing generator (bands flanking its
own corridor, sized by kind, adjacency-chained) inside the same
hull footprint: deck width is shared, and the shorter deck pads
the difference with structure plating dressed as tanks and pipe
runs. The bridge pins the upper bow and engineering the lower
stern, as before.

Two lift shafts at fixed fractions of the corridor (about one
third and two thirds along it, the same columns on both decks) are
the only inter-deck route. Crew routing extends the door-to-door
router with legs: room, corridor, nearest lift, ride, corridor,
room. A ride is shown honestly: the body steps in, fades and
shrinks over about 0.6 seconds of wall time, and reappears at the
other deck's lift; at snap speeds the ride snaps too.

The main canvas shows one deck at a time. Buttons above the canvas
and keys 7 and 8 (or [ and ]) switch; the person card names the
deck ("Engineering, Deck 2"), and tapping a crew member who is on
the other deck switches the view to theirs. A minimap shows both
deck silhouettes stacked, crew as department-colour dots, and a
pulsing outline on a room whose worst system is under 60% (red
under 30%); tapping a half switches to that deck. Static deck
images and wear layers are per deck; both wear layers update every
frame, so a deck scars unwatched. The space backdrop, hull
outline, and day/night light stay shared: it is one ship.

This is viewer-layer derivation, like the deck itself. The engine
has no floors, no lifts, and no deck state; the split is a
presentation of the room graph, derived from the seed, and dies
with the page.

## Chronicle truth mode

The chronicle renders the event log as a ship's log. The config flag
`chronicle.knowsTruth` defaults to true: sabotage lines name the
culprit, marked as what the log knows and the crew does not.
Accusation lines are always rendered as accusations. Turning the flag
off produces the crew's-eye view, where only discovered damage and
spoken beliefs appear.
