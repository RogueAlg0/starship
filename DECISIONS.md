# Decisions

Standing choices for this project, with the reason for each. New choices
get an entry here when they are made.

## Clean-room implementation

The design pattern is learned from a public reference project,
but every line of code here is original. The
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

## Alerts disappear according to urgency (Oct 18, 2026)

The viewer floats its news over the deck as tiered chips
(`viewer/src/alerts.ts`), the way the squad viewer floats battle
news over its map. Nothing is invented: moments come from the same
event stream the chronicle renders, states from the same live
system conditions the sparks read. Viewer-only; the engine is
untouched (the seed-42 gate still reads cf1dffaeb4796f91).

The tier model splits states from moments, because they age
differently. Critical (red) is a state: a system below 30%
condition, or carrying the failed flag, holds its alert for as
long as the condition holds. Its dismiss is a snooze, not a
deletion: the alert stays down only until the band changes, so a
dismissed emergency that gets worse (or better, then worse again)
speaks again. Major (amber) is a moment with a long echo: sabotage
found, an accusation, a grudge formed, trust broken, and a system
crossing below 60%; base lifetime 12 s. Minor (neutral) is the
quiet good news: a repair completed, a system back above 90%
after having been in a band, a bond formed; base lifetime 5 s.

Lifetimes are wall-clock, scaled by playback rate with the rule
scale = clamp(2.5 / max(ticksPerSecond, 0.4), 0.5, 2.5): a major
lives 30 s at the 1x witness pace, 12 s at 2.5 tps, and 6 s at 6x.
The scaling is deliberately mild and bounded both ways, so speed
never makes news unreadable or immortal.

Stack discipline: at most four visible, newest on top, and one
alert per subject (condition states coalesce by system: a slide
from 55% to 28% escalates the same chip through its shapes, timed
bar to dismiss button, rather than stacking a second). Minors are
rate-limited to one accepted per 3 s and are dropped by a full
stack. Majors and criticals displace the oldest minor, then the
oldest timed major; criticals are never displaced, and behind four
criticals a fifth red may stand (the cap is a discipline, not a
blindfold). Tapping a chip focuses what it names: the person card
for a person, a deck switch plus a two-second room flash for a
system. The stack runs on a pure state machine with the DOM as a
renderer, so a headless harness drives the whole tier model on a
fake clock.

The same pass tightened the screen's chrome a notch (thinner
header, section, and control padding, mostly on desktop), the
squad screen's tightness being mostly thin chrome; no touch target
dropped below 40 px.

## Chronicle truth mode

The chronicle renders the event log as a ship's log. The config flag
`chronicle.knowsTruth` defaults to true: sabotage lines name the
culprit, marked as what the log knows and the crew does not.
Accusation lines are always rendered as accusations. Turning the flag
off produces the crew's-eye view, where only discovered damage and
spoken beliefs appear.

## Playtest Note #1: weather changed too fast (Oct 18, 2026)

Reported by the user from a live run: the chronicle showed calm
and solar wind ping-ponging every ten minutes, and a radiation
storm at 03:20 on day one was weather noise, not news. The old
chain rolled every tick (cadenceTicks 1) with weak self-holds
(calm 0.90, solar wind 0.65, storm 0.40), giving expected dwells
of about 100 minutes calm, 29 minutes solar wind, 17 minutes
storm: on the order of 1,500 weather turns in a 60-day run.

Fix, config-level only (the chain, the weather stream, and every
reader of current state are unchanged): the chain now rolls once
per ship hour (cadenceTicks 6) and every state holds hard: calm
[0.97, 0.025, 0.005], solar wind [0.06, 0.92, 0.02], radiation
storm [0.05, 0.10, 0.85]. Expected dwells are about 33 hours
calm, 12.5 hours solar wind, 6.7 hours storm; measured over
60 days the fleet's seeds turn 56 to 93 times, with median
dwells in the designed bands (pinned by test/weather.test.ts).
Storm entry out of calm stays rare (0.005 per hourly roll), and
once a storm arrives it sits on the ship for most of a watch.

This is an engine change, so the seed-42 story is retold: the
30-day gate hash moves from cf1dffaeb4796f91 to ec4e0d23aa3bfde5
(52,017 events over 4,320 ticks, 48 of them weather turns), and
replay reproduces the new stream exactly. Earlier entries in
this file that cite cf1dffaeb4796f91 describe the gate as it
stood when they were written.

## Stores designed, build deferred (Oct 18, 2026)

At the user's direction ("Design Stores first, build later"),
DESIGN.md gained a full Stores chapter: five stores counted in
days of supply (food, water, oxygen margin, fuel, spare parts), a
closed production/consumption loop keyed to system condition,
captain-ordered rationing, theft and hoarding on the existing
beliefs/evidence machinery, and starvation as the slow cause in
the consequences ledger. No code yet; the design is the contract
for the build when he calls it.

## Daily list kept as-is after the weather retelling (Oct 18, 2026)

The weather fix retold every seed. Spot checks under the new
engine: seed 42 (Keel Harbour) is now a fully peaceful month with
zero grudges and 125 bonds; seed 16 became a cascade (32 grudges,
50 sabotages, 526 accusations); seeds 11, 17, 30, 39, 40 kept
healthy drama. Offered a re-vet; the user chose to leave the
Voyage of the Day list unchanged: [11, 16, 17, 30, 39, 40, 42].
The rotation now includes one calm day and one storm day by
accident. So be it; a week with weather in it is honest.

## Playtest Note #3: the presentation was flat (Oct 18, 2026)

The user's verdict, from play: the presentation is text heavy,
"just boring text and lots of scrolling". What he likes in the
squad sim is the opposite register: long-range gunfire made
visible as tracers, slight screen shake, soldiers panicking on
the body. A research pass over the squad viewer's rendering code
(~/workspace/research/squad-feel-starship-translation.md) found
the grammar: every engine event is re-staged in the world at the
tick it is displayed, states are worn on bodies in acts, the
feed is curated to near-silence, and shake is positional
information, not noise.

The response shipped in this build, viewer only: an event
staging layer (viewer/src/staging.ts) that flashes a sabotage
wrong at the culprit's system for the god-witness, bursts sparks
and vented vapour when a system crosses into failure, rings a
finished repair green, and strobes the navigation lights when a
radiation storm arrives; failure telegraphs, so a system in its
worst band coughs irregular spark bursts, strobes its warning
lamp, and breathes a smoke wisp before it dies; and deck shake,
staged blows offsetting the whole scene with (1 - T/span)^2
decay, halved across decks, capped, and gated off entirely
under prefers-reduced-motion. The engine did not move: the
seed-42 gate hash stands at ec4e0d23aa3bfde5.

Queued follow-ups from the same research, in its order: the
accusation made visible (words crossing the room, bodies
recoiling), synthesized sound, and skip-to-next-incident with a
demoted chronicle.

## The Ship's Council adopted into the design (Oct 18, 2026)

At the user's direction (a council of portfolio holders aboard,
on the grand-strategy pattern), DESIGN.md gained a Ship's Council
chapter: seven seats worn over roles (Captain, First Officer,
Chief Engineer, Chief Medical Officer, Security Chief, Science
Officer, Quartermaster), captain-appointed succession, recusal by
bonds and department, and jurisdiction over inquiries,
rationing, discipline, admissions, course and port calls,
emergency powers, and relief of the captain. Voting is computed
from each officer's beliefs in four terms (evidence as held,
trust in the people of the motion, trait and portfolio leanings,
blocs). The verdict machinery adapts the village sim's court,
researched from its source: judges deduce from their own beliefs,
testimony is trust-discounted, distrust itself scores as motive,
and verdicts manufacture grievances against the bench. Adoption
revises the Stores chapter: rationing is now proposed by the
Quartermaster and disposed of by the council, with the captain's
solo imposition an emergency act that expires unratified. Full
research: internal notes.
Design only; no code.

## Ship archetypes adopted into the design (Oct 18, 2026)

At the user's direction, following a sourced research pass on
researched ship and crew systems (internal notes),
DESIGN.md
gained a Ship archetypes chapter: an archetype (one of six roles
- hauler, surveyor, patrol cutter, salvage rig, mining barge,
passenger transport - plus a shapeless Independent, crossed with
three sizes, small ~8 / standard ~12 / large ~16-18 crew) is
drawn from the ship's signature before rooms or crew, and
compartments, systems, roster (with officer specialisations),
stores appetites, and the voyage's meaning are generated inside
its grammar. Brig capacity is a size stat (1/2/4 cells),
borrowed from the researched hull tables. Capabilities gate by
archetype, our adaptation of the reference's equipment gating
(we
have no player to fit modules): only a barge refines ore into
parts; only a surveyor reads space weather a day early; only a
cutter lawfully holds prisoners for other ships. Manufacturers
and faction hull-binding are deferred to the galaxy chapter.
Design only; no code.

## Playtest Note #4: the ship felt empty (Oct 18, 2026)

The user's verdict after watching the daily voyages: the ship felt
empty. Nobody kept a schedule, nobody ate together, free time did not
exist, and rumour (suspicion spread from accusations) travelled
between people who never met. The response is the Ship's Routine, an
engine build in src/ with a minimal viewer line.

What shipped. Each crew member gains a deterministic routine at
generation: a watch (day, or a night watch of two drawn by role
affinity, one from the engineering pool and one from the
bridge/security pool), a sleep block, work blocks, and free blocks,
shifted an hour either way per member and bent by traits
(disciplined members keep the base shape; restless members sleep an
hour less). The per-tick activity choice is schedule-first: work
blocks work, sleep blocks rest, meal windows pull the awake ship to
the mess, free blocks offer leisure; critical needs and a failed
system in the member's own department still override the schedule,
through the existing candidate machinery. Two meal windows a day
(07:00 and 18:00 ship time) seat eaters at tables of up to four,
deterministic from co-presence; the chronicle prints one summary
line per sitting, plus a notable pairing when a table holds one.
Gossip is a transfer function with a hard co-location rule: it runs
only inside a shared meal or a shared free-time conversation, a
suspicion at or above 0.48 can pass to a companion in a small amount
scaled by trust, never above the teller's own level, and never past
the listener's own accusation threshold on rumour alone. The log
stays silent on ordinary gossip; it prints a line only when a
transfer tips the listener to their threshold, at most once per pair
and target per day. Companions in shared free time also drift trust
by a hair, in the direction of the relationship they already have.
Free time has texture: table games in the mess (2 to 4 players, one
winner, small bond and morale effects), exercise in the gym, reading
in quarters; games reach the chronicle, exercise and reading do not.
The viewer's person card gains one line: watch and current block.

Two balance changes rode along, both forced by the schedule itself.
A scheduled ship empties its system rooms for hours (the crew is
asleep, or all at table), so solitude with a system, the sabotage
gate, became far more common; the sabotage cooldown rose from 288 to
720 ticks to restore the intended act frequency, and a full mess at
mealtime no longer counts as a crowd for stress purposes. Gossip
took three tuning passes: the first settings produced a paranoia
cascade, and an A/B run with gossip disabled proved the schedule,
not the gossip, was the main amplifier; the hearsay ceiling (rumour
cannot carry anyone past their own threshold) is what finally kept
the slate's shape.

New seed-42 30-day fingerprint: hash b4f952711cb7ec7e, 34,478 events
(the old run was 52,017; resting now records once per sleep instead
of once per hour), about 4,000 ticks per second. Drama slate,
grudges / sabotages / accusations over 30 days, new engine: seed 11:
2/2/0. Seed 16: 76/28/497 (still the storm ship, as before). Seed
17: 5/5/8. Seed 30: 3/6/17. Seed 39: 2/3/26. Seed 40: 30/16/206,
the one seed that flipped hot; its evidence and accusation machinery
ignites once gossip primes it, and we accept it as a second
storm-leaning ship rather than tuning the whole fleet to its
measure. Seed 42: 1/4/2, gentle. Seed 99: 9/7/94, warm. Against the
pre-routine slate, seeds 17, 30, and 39 gained healthy warmth and
the flagship stayed calm.

Deferred on purpose: the gossip distortion variant (a suspicion
attaching slightly to a second person the teller distrusts) stays
off and is noted as future work; the insomnia override was omitted,
because a sleep block that reliably rests is what makes the night
watch read as a watch.

## Performance pass (Oct 18, 2026)

The user reported the live ship view "a lil laggy". A research
pass (~/workspace/research/starship-viewer-performance.md) read
both reference viewers for their frame discipline and ranked our
costs against it; this build implements its top five fixes plus
two small ones, all behaviour-preserving (the seed-42 hash is
unchanged: b4f952711cb7ec7e; 40/40 tests green).

1. Chronicle drain batching. The drain appended each line with
   its own DOM insert and, when stuck to the bottom, its own
   scrollHeight read: one forced layout per line, inside the
   frame, growing with playback speed. Lines now collect during
   the drain and append once through a DocumentFragment; the
   300-line cap trims once and the scroll settles once per batch.
2. No canvas filter on the crew pass. Night bodies were drawn
   under ctx.filter = brightness(...) for the whole bodies loop,
   an intermediate-surface pass every frame of the night watch.
   Bodies now come from pre-tinted sprite variants in the bodies
   cache, keyed by a dim bucket (0.05 steps): a night body costs
   the same drawImage as a day body.
3. Glow gradients built once. The hydroponics sweep gradient and
   the reactor/engine radial glows were allocated every frame
   with the pulse baked into their stops. The sweep gradient is
   built once in a canonical span and translated into place; the
   glows are built once per deck at fixed geometry with the peak
   stop at full strength, and condition x pulse rides on
   globalAlpha.
4. Wear folded into the static deck, and a paused throttle.
   Each deck's wear layer is composited over its static canvas
   whenever the wear layer repaints (its bucketed signature
   change), so a frame blits one base canvas instead of two; the
   render order is unchanged (wear still under the tint, glows
   and labels still above it). While paused, the deck redraws at
   about 15 fps with the true elapsed dt handed over, so drift
   and sway keep their speed and only their rate drops.
5. The frame loop de-allocated. The staging sync's input rows
   are persistent objects mutated in place, and the staging
   layer mutates its tracked per-system state instead of setting
   a fresh object per system per frame (its crossing test reads
   the band captured before the sync). Slot/rest/positions maps
   and the draw-order array are scratch fields, cleared and
   reused; per-room system lists are resolved once per ship.

Small ones: system label text is a painted sprite per room,
repainted only when the worst system, its rounded percent, or
its colour band changes (the condition bar still draws live);
alert lifetime bars are CSS animations armed at chip build or
span refresh instead of per-frame style.width writes, and the
roster need bars in updateSlowUi are written only when the
rounded percent or band changes.

Not done: Finding 7 (minimap silhouette caching). The minimap
is a 176x56 canvas already throttled to 250 ms; the caching
restructure was not free, and the research ranked its win low.

## The mundane is the game (Oct 18, 2026)

Direction ruling by the user. After the feel and routine work he
reported the game still felt like a scroll fest, and a proposed
fix (cold open at the first incident, a skip-to-next-incident
control, a daily digest as the main reading surface) was put to
him. He declined it plainly: "Nah dont think that's what I want
frankly. I like the routine mundane stuff." The ordinary days -
watches, meals, work, sleep, the small life of the ship - are
the content, not the dead air between incidents. No future
design may cut, skip, or summarize away the routine as its
primary move. The standing direction is the opposite: stage the
mundane so it can be watched (the deck carries the day), demote
the chronicle to a minor channel, and fix performance so that
watching is pleasant. This retires translation-table items #12
(skip-to-next-incident) and the digest-first reading of #9 from
the squad-feel research; both may exist later only as minor
conveniences, never as the game's shape.

Staging the mundane (Oct 18, 2026): on the user's "Let's do
it", the reframed plan was adopted as a DESIGN.md chapter of
the same name. Chronicle demoted to highlights-by-default with
the full log one toggle away; meals staged with a seated
posture and filled chairs; errands shown by carried items;
free time given furniture (games seated, gym machines in use,
readers with books); a ship's day ribbon naming the current
block and the next beat. Viewer-only; the engine is untouched.

## Staging the mundane, built (Oct 18, 2026)

Viewer-only build of the DESIGN.md chapter above; nothing under
src/ changed and the gate held exactly: seed 42, 4,320 ticks,
34,478 events, hash b4f952711cb7ec7e, replay exact, 40/40 tests.

What shipped:

- Chronicle highlights mode: a Highlights / Full log toggle above
  the chronicle, defaulting to Highlights, its state carried in
  the URL (?log=full) and localStorage. Highlights prints the
  renderer's own drama lines plus, by event type, the shared
  meal sittings (meal_service, which the renderer files as
  routine), games, bonds, grudges, accusations, sabotage,
  failures, repairs, weather turns, and the firsts. Movement,
  rest, work, and solo meal lines do not print. Switching modes
  rebuilds the visible log from the retained buffer; the batched
  append and the 300-line DOM cap are unchanged.
- A seated posture in the body dictionary (one row lower, legs
  folded, hair overlays offset to follow the head), painted
  through the same sprite cache. Crew eating in the mess take
  chairs at the tables in roster order; table-game players sit
  facing each other across a table with a board glyph between
  them; readers sit where they stand, book drawn in hand.
- Carried items, derived conservatively in the viewer from move
  events: a member heading to a room holding a damaged or failed
  system they can repair (the engine's affinity-plus-skill test)
  carries a tool case; a member leaving the cargo bay carries a
  stores crate. Everything else is empty hands.
- Free-time furniture: exercisers take gym mats in roster order
  and animate on the existing two-frame working tempo; games are
  tracked from their leisure_game event and seat their players
  for one ship hour (six ticks), the engine's own span for one.
- The ship's day ribbon under the header: watch phase, the block
  most of the crew are in (the night hours read "Night watch"
  when the pair is on duty and the ship asleep), and the next
  beat of the printed day with its time. Written only on change,
  on the 200 ms slow-UI cadence.

Derivation discipline: every new state is read from the snapshot
the viewer already receives (activity + room, table/mat anchors
from the deck layout's own props) or from the event stream it
already drains (leisure_game rosters, move destinations). No
engine field was added and no sim behaviour changed. Bundle grew
266,997 -> 279,136 B (dist) for the new staging code and sprites.

## Hull exterior view, built (Oct 18, 2026)

The second half of the user's "Both, decks first" arrived: the
decks shipped, the exterior followed. New module
`viewer/src/exterior.ts`, driven by the DeckView, which owns the
sky, the shake transform, and the staging feed both views share.

Derivation: the silhouette is computed from the ship signature
the viewer already holds, in the deck plan's own pixel footprint
(the same stern, bow tip, and mid-height, turned sideways). Hull
length and the two window bands come from the deck plan's width
and deck count; each compartment's windows spread across its own
room rect's span, rowed by deck and nudged by which plan band the
room sits in; the bridge blister rides the spine over the bridge's
span, the sensor mast stands over the lab, the airlock hatch sits
at the airlock, and the engine bells reuse the wear layer's stern
block geometry. Archetypes are designed but not yet in shipgen,
so character is read off the ship that exists: a wide cargo bay
bellies the hull and hangs pods under the keel, a small ship draws
sleeker, and the bow (needle or blunt), livery stripe, spine, and
keel are the seed's hash picks. Same seed, same ship: a headless
harness compares the full paint-call stream of two constructions
and finds them identical, and seed 7's ship different.

What is live: the windows (the interior made visible: a room with
crew awake in it is lit in its kind's colour, a room of sleepers
sits at a dim night-light, an empty room keeps the day's ambient
or the night's standby, hydroponics always burns green, and at a
meal window the mess goes warm with a halo); the engine plume and
exhaust shimmer (length and brightness from the engines'
condition and whether the ship is underway, guttering when the
engines have failed); the running lights (the staging layer's
storm-arrival strobe feeds them, and in storm weather they burn
doubled with halos); the shake, inherited whole from the staging
layer, storm kicks included; and damage on the skin (a system
below 30% sparks at its hull station, a failed system vents
vapour until it is mended, and the staged moments (sabotage,
failure, repair) fire at the station from the same feeds the deck
uses). What is static: the silhouette, painted once per ship; the
window lights and the hull wear (the wear layer's own tracks:
the engines' worst day scorched and pitted at the stern, the age
stain, per-system scorch and repair plates) live on their own
canvases and repaint only on bucketed signature changes, verified
by harness (no repaint on an unchanged frame; a repaint when the
ship's light or a damage bucket moves). A frame outside is three
blits, the plume sprite, the lights, and a particle pool capped
at 160 whose positions are pure functions of age; both gradient
sprites are built once, beside the silhouette.

Interaction: the view switcher gains an Exterior button and key
9; the deck keys and the minimap come back inside (stepping out
never moves the deck focus, so returning restores it); a tap on
the hull goes to its deck (engine block and lower hull to Deck 2,
blister and upper hull to Deck 1, sky to nothing). The chronicle,
alerts, roster, and ribbon are untouched, and crew keep walking
while the witness is outside, so the minimap stays live.

Viewer-only: nothing under `src/` or `test/` changed. Gates:
tests 40/40, purity green, typecheck clean, seed 42 at 4,320
ticks holds 34,478 events and hash `b4f952711cb7ec7e`, replay
exact. Bundle grew 279,136 -> 315,032 B (dist) for the new module.
Descoped: a hover readout on the hull (not required; taps carry
the interaction), and archetype-named silhouettes (archetypes are
not in shipgen yet; the grammar above is the stand-in the design
chapter prescribes until they are).

## Galaxy step 1: sector, ports, and the leg, built (Oct 18, 2026)

The first layer of the galaxy chapter: the universe stops being a
backdrop. New module `src/world/galaxy.ts`, drawn only from the
"galaxy" stream, generated at build like the ship and the crew,
and registered as the "voyage" system between weather and crew.

The sector: 6 to 9 ports and 3 to 5 factions per seed, all named
from syllable tables in config (Kestrel Reach, the Vostok
Combine). Positions sit on a jittered 3x3 grid over a 60
light-day square: one port per cell, offset 6 to 14 light-days
inside it, so the 12 light-day minimum separation holds by
construction rather than by rejection luck. Each faction holds a
home port; the remaining ports declare for a faction by roll or
stay independent (25 percent). Each port carries a character
from a small table (industrial, agrarian, free port, refinery,
shrine, company town, shipyard, listening post): flavour in
step 1, machinery later.

The leg: the origin is a stream pick; the destination is drawn
from the ports inside a chartered band, 12 to 26 days out at the
config cruise speed of 2 light-days per day, with the
nearest-to-band port as fallback when a sector offers none.
Distance is the real grid distance; leg ticks are that distance
over cruise, rounded. The ship's position is a pure function of
the tick count (elapsed over leg ticks, interpolated), so
replay has nothing to reproduce but arithmetic. Departure at
tick 0 now names both ports and the distance; arrival fires
exactly once, on the leg tick, and from that tick the world
flag reads in port. The shipboard sim does not stop at the
dock: the remaining ticks run aboard a ship in port, her
routine and drama unchanged. Across the daily seeds and 99,
legs run 12.5 to 23.3 days and every seed arrives inside the
30-day run; the G/S/A drama table is identical to the
Routine-era table on every seed, because the galaxy layer
touches no shipboard system. Event count rises by exactly
one per run: the arrival.

The viewer gains the fourth view: the star map (Map button,
key 0 or M), a chart of the sector with ports in faction
colours, the route dashed and the sailed part solid, the ship
walking it, and a port card on tap (faction, character,
home-port flag, and the distance from the ship right now). The
header carries the leg: origin, destination, days out, days
to go, in port after arrival. The chart's static layer paints
once per voyage into an offscreen canvas; per frame only the
marker and two pulses draw, and a headless stub-canvas harness
verified the painting, the picking, and the distance
arithmetic. Departure and arrival are highlight-class in the
chronicle filter.

Stubbed for later steps, deliberately: traffic and contacts,
convoys, patrols, bounties, the Conquest tick, everything a
port call will mean (resupply, hiring, docking), and any Stores
integration. Weather keeps rolling in port; nothing
special-cases it yet.

Gates: tests 51/51 (11 new in test/galaxy.test.ts; the slice
suite's departure-line assertion updated to the routed
sentence), purity green, typecheck clean, replay exact via the
CLI against the regenerated runs/seed42 recording. New
seed-42 fingerprint: 4,320 ticks, 34,479 events, hash
173a304792141f39, about 4,300 ticks/sec; decisions unchanged
at 51,840, because the voyage draws none. Bundle grew 315,032
-> 339,331 B (dist) for the sector in the engine and the chart.

## Galaxy step 2: traffic, built (Oct 18, 2026)

The sector stops being empty. New module `src/world/traffic.ts`,
drawn only from a new "traffic" stream at build, registered as
the "traffic" system after voyage. Six to ten other ships per
sector: names from the signature's own tables, unique in the
sector and never the witnessed ship's name; a type from a small
table (hauler, courier, tanker, salvage rig, patrol cutter,
passenger transport) carrying a cruise factor of 0.8 to 1.3
times the player's cruise; a registry in one of the sector's
factions or independent. A registered ship's home port is her
faction's home port.

Schedules, not agents. Each ship's leg table is generated up
front to a 400-day horizon: chained legs between real ports,
stays of half a day to three days, the first stay drawn like
any other so no ship sails on tick 0. Her position at any tick
is a pure function of that tick, under the same interpolation
discipline as the player's leg. Traffic draws nothing and
decides nothing during the run: the tick loop's cost stays
flat in the ship count, replay has nothing new to reproduce,
and the decision count does not move.

Contacts are geometry, witnessed. Each tick the traffic system
measures every ship against the player's position. A ship that
crosses the 8 light-day sensor line raises one contact event:
name, type, registry, the range at detection, her business
(bound for a named port, or in port at one), and her motion
(closing, passing, parallel, berthed) from the radial rate. She
leaves with one contact_lost. The range is 8, not the 6 first
drawn: measured at both, one daily seed's whole month passed
at 6 without a single traffic line of any kind, which is the
barren sky this step exists to end. While the player lies in
port, ships berthed at or bound for that port are not sensor
contacts at all; their arrivals and departures speak instead
as port_traffic lines. A contact that turns port-local on the
player's arrival closes quietly, and her own arrival speaks
as port traffic. A per-tick invariant checks the contact
ledger against the geometry: an announced contact is in
range, and every position stays inside the sector square.

Transponders are truthful in this step, and that is a v1
simplification, not the design. A contact's stated name, type,
registry, and business are accurate, because there is nothing
yet that could act on a lie. The beliefs pillar wants
transponders that can deceive: spoofed identities, dark ships,
a registry that does not match the hull. That uncertainty is
deferred to the bounty step, where being wrong about a ship
carries a price. Nobody should read step 2's honesty as the
settled design.

Measured across the daily seeds and 99, per 30 days: seed 11,
10 ships, 0 contacts, 2 port movements; 16, 6 ships, 1 contact,
2 movements; 17, 10 ships, 3 contacts, 4 movements; 30, 7
ships, 3 contacts, 2 movements; 39, 10 ships, 2 contacts, 1
movement; 40, 7 ships, 1 contact; 42, 9 ships, 3 contacts; 99,
10 ships, 5 contacts. A quiet sky some months, a busy one
others: the register the chronicle already keeps.

The viewer: the chart gains the traffic as small diamonds in
their registries' colours, dimmer than the witnessed ship's
marker, positions computed viewer-side from the same pure
functions off the snapshot's traffic table. Only the selected
ship wears her name. A tap on a marker opens a ship card on
the port card's shell: type, registry, present business, and
the range in light-days and in days at cruise. Outside, while
an underway contact holds, her shape crosses far behind the
hull: a few pixels and two running lights on a three-day
traverse keyed to the contact's opening tick and the bearing
of her leg. Berthed contacts cross no sky; no contact, no
traffic. Contact, contact_lost, and port_traffic are
highlight-class in the chronicle filter.

Stubbed for later steps, deliberately: any interaction
(comms, boarding, trade), patrol behaviour and suspicion,
bounties and the spoofed transponders they bring, Conquest,
and everything a port call will mean.

Gates: tests 64/64 (13 new in test/traffic.test.ts, including
a contact ledger re-derived from the position functions alone
and matched event for event against two seeds' streams),
purity green, typecheck clean, replay exact via the CLI
against the regenerated runs/seed42 recording. New seed-42
fingerprint: 4,320 ticks, 34,485 events (six more than step
1: three contacts and their three losses), hash
a2ccd3627b927733, about 5,700 ticks/sec in the suite's own
timing and about 4,100 through the CLI with file sinks;
decisions unchanged at 51,840, because traffic decides
nothing. Bundle grew 339,331 -> 362,414 B (dist).

## Galaxy step 3: stores and port calls, built (Oct 18, 2026)

The ship eats, burns, and breathes. The voyage is no longer one
leg and a full stop: the Voyage class now holds an itinerary
generated whole at build, the way traffic schedules are. Leg 1
is the charter, drawn exactly as step 1 drew it (same stream,
same band, the capital-A `arrival`); later legs are picked as
the table is laid down — never the port she lies in, never
straight back the way she came when the band offers an
alternative, weighted toward ports the run has not visited — and
their arrivals are plainer `port_call` events. Between legs she
lies in port one to three drawn days, bent by the port's
character (a free port or a shipyard keeps her a day longer; a
company town, zero, turns her around on the company's clock).
Positions stay a pure function of the tick given the itinerary,
read off a voyage clock; the traffic ledger test still derives
every contact from the position functions alone.

Cross-reference (Oct 18, 2026): the course decisions entry at
the end of this file supersedes the "itinerary generated whole
at build" model above for legs after the charter. Legs after
the first are now decided at council sittings during each
stay; the voyage holds no future legs in advance. The
departure, stay, resupply, and fuel-floor behaviour described
in this entry is unchanged.

Five stores — food, water, oxygen margin, fuel, spare parts —
ride in integer milli-units under a fractional carry, and read
in days of supply: quantity over the day's draw. Production is a
system's rate times its condition (the hydroponics rig at 106%
of appetite, the recycler at 108%, life support at 120%, the
fabricator at 3,600 milli-units a day while the engineering
department stands its watches). Consumption is the crew living,
the engines burning by the light-day, and repairs paying for
the condition they restore out of the parts locker: a short
locker buys a smaller repair, an empty one crawls at 0.35.
Thresholds speak once per crossing per arming (`stores_low`
below 10 days, `stores_critical` below 4, re-arming only above
threshold plus 2). Zero stores bite at the level of needs only
— hunger that cannot recover, morale pressure, a straining
life support. Nobody dies of an empty store in this build: the
consequences and death engine is not built, and that boundary
is deliberate, recorded here so a later build lifts it on
purpose rather than by drift.

Rationing is INTERIM. The Council chapter says the
quartermaster proposes and the council disposes, but the
Council is not built; until it is, the quartermaster imposes
rationing as an emergency act below 12 days (his traits bend
the trigger: anxious earlier, kind later — one table, two
hooks), and it lifts above 16 or on arrival. When the Council
lands, the imposition becomes a proposal and this entry is
superseded. There is NO money in this build: resupply is by
charter right and port reciprocity, capped by the port
character's table, and prices are future work that must not
be half-invented here. Harbour news is COLOUR in this build —
berthings, recent comings, faction rumour — and moves no
belief; news-as-evidence arrives with the bounty step.

The port call is the spring the step-2 entry stubbed: in the
first hours the manifest (an agrarian fills the food, a
refinery the tanks, a shipyard the locker plus dockyard hands
on the worst system, a shrine almost nothing material and a
gift of morale, a company town everything and a port-dues
line, a listening post nearly nothing but news); across the
stay, shore leave in rotations — off-watch crew ashore, off
the deck, off the roster's face, restoring company faster
than any hour aboard — and one flavour incident per call at
most. Every port fills fuel to at least the departure floor
(55% of the tanks, more than the longest leg in the band):
emergency bunkering is a right of the road.

Theft came with the stores, on the beliefs machinery's terms.
A hoarding trait joins the pool; when food is rationed or
under 8 days, a hoarding hand may take 350 milli-units into a
private cache on a "stores"-stream draw. A witness in the
stores room makes evidence (suspicion, through driftSuspicion;
no new accusation path was built — the existing one hears it
from there). Unwitnessed, the loss sleeps until the
quartermaster's tally: a `stores_discrepancy`, with suspicion
landing on the thief only when someone awake stood in a room
adjoining the stores — partial evidence, a direction to look.
Caches are eaten in secret at the day boundary, and the books
reconcile to the milli-unit (a test holds the identity over a
forced-scarcity month). Ashore crew are alibis: the sabotage
evidence path, the gossip tables, and the society step all
skip them.

Drift, and a catch worth naming: the first design froze the
voyage clock at an empty tank. The hosted copy's accuracy pass
found the same bug in its own build and named it — fuel rises
only in port, so a frozen ship never arrives and never
refuels: a permanent soft-lock, reachable in normal play. The
rule as built: a drifting ship makes way on momentum at a
quarter of her voyage clock (CONFIG.galaxy.driftRate), the leg
stretches fourfold, `dead_in_space` fires once, and arrival
stays reachable from any state. A test pins it (tank held at
zero from mid-leg: the Arrival still fires inside the bound,
and the manifest refuels her at the dock). The fleet check
agrees with the design intent — across seeds 1-60 at 90 days,
no ship drifted at all and none ended stranded: the departure
floor makes the drift a safety valve, not a story.

Balance, daily seeds plus 99 over 90 days, measured at the
final tuning: food never below 36.9 days, water never below
32.5, oxygen margin never below 24.2, fuel never below 10.8,
four port calls per ship (three on seed 16), rationing zero
days, thefts zero — scarcity never came, so the theft and
rationing machinery is proven by constructed tests, not by
the table. Spare parts are the one
store that empties: in a damage cluster the locker drains
(8,000-14,000 milli-units of repairs a day against 3,600 of
fabrication) and sits empty for stretches of the worst month
(5 to 15 sampled days per seed) while repairs crawl at the
floor and the next port refills it. That is the chapter's
shortfall rule working, recorded plainly rather than tuned
away: a higher repair cost was measured and rejected, because
it made the crawl permanent and starved the other stores
through unrepaired recyclers.

The viewer: a stores strip under the weather banner (five
slim bars, whole days, a trend arrow from the standing net
flow, bands matching the alert tiers, write-on-change on the
slow cadence); stores alerts through the existing stack
(low = major, critical = critical, rationing = major, a tap
going to the quartermaster or the store's producer system);
ashore crew absent from deck and minimap, "Ashore" on the
roster row, "Ashore at <port>" on the person card; the map's
marker wearing a docked ring in port and the header reading
"In port at <name> · day N of M · sails <day, time>" on the
existing idiom; resupply, rationing, theft, thresholds,
discrepancy, harbour news, shore leave, and port calls all
highlight-class.

Not built, by the brief's fence: the locked stores door and
stores access control, graded ration levels (one interim
level only), mercy theft, prices and money in any form, news
moving beliefs, and anything of the consequences engine.
Hostile weather for stores (spoiled food, contaminated water)
was not in the brief either and is not built.

Gates: tests 80/80 (12 new in test/stores.test.ts; the galaxy
suite gains the itinerary block — charter first, chained legs
and stays, stay arithmetic, the no-backtrack rule, arrivals
matched leg for leg against a 90-day stream; the traffic
suite's port-traffic derivation now reads the port from the
itinerary), purity green, typecheck clean on both configs,
replay exact via the CLI against the regenerated runs/seed42.
New seed-42 fingerprint: 4,320 ticks, 34,079 events (406
fewer than step 2 — the trait pool grew a hoarding entry, so
crews draw different traits and the month's drama re-deals),
hash 9e324b16a2333ec6, about 3,900 ticks/sec through the CLI
on a clean run; a same-session A/B in a bare harness against
the step-2 code reads 2,243 against 2,170 ticks/sec, about a
3% cost for the new system. The 90-day reference run: 12,960
ticks, 102,785 events, hash b25d0ee3a83c6af1. Bundle grew
362,414 -> 414,182 B (dist): the stores engine joins the
viewer's imports.

## Consequences and the Ship's Council, built (Oct 18, 2026)

The ship can now hurt, sicken, die, and judge. Two new systems
run last in the tick, health then council, and the boundary the
Stores entry recorded is lifted on purpose, by this chapter's
own model only: nobody dies except through the harm ledger.

Health (src/world/health.ts). A body is wounds per part (head,
torso, arms, legs) with severity, bleeding, and infection risk;
sickness as a level; lasting marks (lame leg, ruined hand, lost
eye, scarred torso) when a wound lands deep; and a per-cause
ledger that is the ground truth of the body. Every point of
harm is booked at the moment it lands, and bookHarm books only
the effective amount after clamping, so the identity health =
1 - sum(ledger) holds exactly and is invariant-checked. Harm
arrives by modeled chains only: accidents over work actually
done (scaled by danger, storm, failed lighting, fatigue,
hurry); cascades (life support low is thin air shipwide, a red
reactor is radiation in its room, an empty store is thirst,
hunger, and no air); sickness from bad water, bad air, and
crowding, spreading by co-location; and rare grudge violence
behind a stack of gates (settled grudge, trust at the floor,
morale and needs in despair, the grudge old). Treatment is
work: a treat candidate in the medbay, the badly wounded
carried there, healing in days. Endings: ship lost (life
support failed with no oxygen margin, or the reactor at its
floor, sustained two days; abandon ship drawn by distance and
health) and crew collapse (fewer than three able crew).

One bug the tests caught and this entry records plainly: the
first build checked death at the end of the health pass, after
the background recovery booking, so a body in a slow cascade
oscillated at one tick's worth of health forever (harm to zero,
recovery back, repeat) and nobody could die of thin air. Death
is now checked between the harm bookings and the healing
bookings: harm that brings a body to zero kills that tick.

The Council (src/world/council.ts). Seven seats worn over
roles, the cook excluded; seats follow roles, and vacancies
are filled by the captain's appointment from the surviving
crew (the First Officer seat alone needs a ratification vote).
A vacant seat degrades its domain: no CMO is lay judgment at
inquiries and slower, lay healing; no QM is drifting stores
counts, booked as charged so the stores identity still
reconciles. Jurisdiction built: boards of inquiry (every
death, automatically; sabotage above a damage threshold;
stores theft with a named suspect; a Security-certified
accusation), discipline short of inquiry, rationing,
emergency powers, and relief of the captain. Rationing
REPLACES the Stores interim entire: the quartermaster
proposes (their traits bend the trigger, as the interim's
did), the council disposes, levels are reduced or strict, and
the captain's emergency imposition below six days expires
unratified within a day; a refusal of ratification lifts the
rationing and leaves the blame with the captain. Votes are
computed, never rolled: evidence as the officer holds it,
trust in the motion's people, trait and portfolio leanings,
and a bond-bloc second pass; the captain breaks ties, holds a
veto over discipline only, and never votes on relief.
Recusal: accused, accuser, victim, and the closely bonded
stand down. "Closely bonded" is relative (among an officer's
two closest bonds aboard, and warm in absolute terms),
because shipboard bonds saturate: after a month, half of all
pairs sit at 0.9 or above, and an absolute line stood down
half the bench for any well-liked accused. Relief: three
officers at the trust floor with settled grudges may table;
carries on five of seven or two-thirds of sitting officers,
votes recorded; the First Officer takes command and the
relieved captain is confined a week. Legitimacy, the sixth
unnumbered store, moves with crew agreement after findings.

Judgment calls and tuning history, recorded honestly. The
first fleet tuning ran an epidemic: sickness recovery applied
only when its sources were zero, so the meal crowd's drip
ratcheted the whole ship sick and deaths ran 4 to 9 per seed,
all sickness. Recovery now always applies, weakened on a
fouled ship, and the sickness numbers were retuned; sickness
events went to zero fleet-wide, which is the other edge of the
same knife and is recorded as such. Council fallout at first
ignited the feud engine (testimony pushes plus directly
pushed grudges manufactured sabotage, which manufactured
sittings); fallout now drifts trust only, at roughly half the
first magnitudes, testimony pushes halved, and judicial
sittings sit behind a five-day gap. On seed 17 the council
confined the engineers, life support and the reactor failed
together, and the ship spiralled toward collapse; the air
harm was halved so that spiral takes ten days instead of
four, time for repairs, an emergency grant (which raises the
parts-shortfall repair floor from 0.35 to 0.7 while it
stands), or a port to matter. Confined crew are fed in
quarters: confinement is the room and the idleness, not
starvation. A note on drama levels: the late-voyage feud heat
at 90 days is pre-existing, not a council regression; measured
A/B on seed 42, the Stores-era code runs 103 sabotages and
1,535 accusations over 90 days, this build 97 and 1,471.

Balance, daily seeds plus 99 over 90 days, at the final
tuning: deaths zero on every seed; injuries 2 to 7; attacks
0 to 1 (seed 30); sittings 11 to 28, of which inquiries 4 to
10; sentences 8 to 16; relief motions at most one per voyage,
carried on the three hot seeds (16, 40, 99) and failed
elsewhere. Zero deaths is inside the frequency law (zero to
two per typical voyage) at its floor, and the same honesty
applies as in the Stores entry: the death machinery is proven
by constructed tests (a suffocation cascade that kills through
the ledger, grudge violence in a health-only harness, the
ledger reconciling on every death), not by the table.
Legitimacy saturates at 1.00 on calm seeds: agreement with
acquittals is near-unanimous aboard a quiet ship, so the
store fills and stays; it moves on the hot seeds (0.97 on
seed 99) and after contested findings.

Deferred, with reasons. Admissions and course/port decisions
are not built: their inputs (crew arrivals, distress calls)
are unbuilt systems, and a jurisdiction with nothing to judge
would be theatre. The designed Arrival ending assumed a final
destination; the voyage is a circuit now, so no arrival
ending is built and none is forced; the endings are ship lost
and crew collapse. The Stores header and this chapter's
headers in DESIGN.md are updated from designed to built; the
Stores header had been stale since step 3 landed.

The viewer. Sittings stage in the mess: the convened event
seats the officers at the mess tables in seat order (main.ts
holds the roster and passes presentation copies, so the deck
walks officers across the ship without the sim being asked),
the accused stands at the open end with the security chief
beside them, and the finding raises vote tokens over heads in
seat order (green tick, red cross, dots for abstention)
through the bubble layer. The wounded stand hunched with a
bandage painted into a new hurt sprite in bodies.ts; the dead
and the put-off leave the deck and the minimap, and the
roster marks them Deceased or Put off the ship. The person
card gains a Body record: health, wounds by part with
infection, sickness, lasting marks. Legitimacy rides the
stores strip as a sixth cell (no days, no trend: a percentage
and a band). Deaths, injuries, sittings, verdicts, relief,
and the endings are highlight-class and alert-fed (death and
the endings critical, relief and injury major).

Gates: tests 95/95 (14 new: 6 in test/health.test.ts, 8 in
test/council.test.ts; the two interim rationing tests in
test/stores.test.ts rewritten to pin the new boundary, plus a
strict-level arithmetic test), purity green, typecheck clean
on both configs, viewer builds. Replay exact via the CLI
against the regenerated runs/seed42. New seed-42 fingerprint:
4,320 ticks, 34,072 events (7 fewer than the Stores build;
the candidate lists changed, so the month's decisions
re-deal), hash 7525905c8b5f6c32, about 3,060 ticks/sec
through the CLI. The 90-day reference run: 12,960 ticks,
99,407 events, hash 19330fe257de8ca9.

## Crew skills chapter adopted (Oct 18, 2026)

DESIGN.md gains "Crew skills: the hands learn", designed at the
maintainer's direction after the question of whether crew have
levels like other colony and life sims. Today they do not: one
flat competence number, rolled from the role's base at
generation, never moves. The chapter replaces it with seven
disciplines (Engineering, Life Systems, Hydroponics, Medicine,
Fabrication, Operations, Husbandry), levels 0 to 10, and
experience booked from work actually done, the harm ledger's
rule mirrored: XP names the task that taught it, scales with
the difficulty of the work, failure teaches at half rate, and
the booking draws no randomness. One passion per person
(double rate, may fall outside the role), necessity teaching at
the passion rate for appointed cover, rust that eats only the
gains, believed skill held per observer in the belief stores
(the captain appoints by believed skill and can appoint
wrong), and lasting marks capping disciplines from the
consequences build. The old flat number is removed, not
blended; every formula that read it reads the relevant
discipline's level. Tuning law: one to two levels in a primary
discipline per 90 days of sailing (a measuring window, not a
voyage length; the sailing is open-ended), two to three with
passion, nobody maxes what they did not board near. Design
only, no code. Open questions recorded in the chapter:
believed skill per observer (leaning yes), mentoring needing
co-presence only (leaning yes), passengers and synthetics
holding levels (deferred with their chains; the ledger shape
must not assume a role).

## Council-made course decisions endorsed (Oct 18, 2026)

The Consequences and Council entry above defers course and
port decisions because distress calls are unbuilt. Recorded
separately, so the direction is not lost: the maintainer
explicitly wants the council making the ship's decisions, each
officer bringing their own bias, and endorses promoting the
next-port choice from pure itinerary logic to a council
decision (navigator proposes; quartermaster counts fuel and
days of supply; the doctor reads the crew, the engineer the
ship; the captain holds agenda and tie-break). This is the
natural next arc after this build, ahead of or alongside the
distress-call half of the jurisdiction, which still waits on
the rescue chain.

## Council course decisions, built (Oct 18, 2026)

The endorsed promotion is built. Leg 1 stays the charter,
drawn at build exactly as before. Every later leg is decided
by a council sitting, convened 12 ticks into each stay, one
sitting per stay. The voyage builds no itinerary ahead: the
Voyage class holds only the current leg, and it lays the next
leg when the sitting records its decision. Stay lengths are
still drawn on the galaxy stream, in arrival order, as each
arrival lands, so stream order is unchanged.

The chart: the navigator proposes the ports inside the
chartered band (12 to 26 days), sorted by distance, current
port excluded. The previous port is admitted under a standing
penalty instead of the old never-straight-back rule, so a
council can vote to return and the chronicle can say why. The
old 3:1 unvisited weighting is gone as a silent draw; the pull
toward unvisited ports now lives in the officers' prices,
chiefly Science's.

The vote uses the existing four-term machinery with a course
branch; no new voting engine. The captain tables their own
best price as the motion and does not vote except on a tie,
as in other non-inquiry business. Each voter's score is their
price for the motion port minus their best alternative, with
trust in the navigator priced on the navigator's
recommendation. The Quartermaster counts stores: fit is need
times weight times the port character's supply, and the parts
weight grows as the ship hurts. The Chief Engineer prices
shipyard pull and distance risk against damage. The Chief
Medical Officer prices leave values, morale, and hurt crew.
Science leans to unvisited ports and listening posts. Security
leans by port character, with a penalty for a port where the
ship was recently robbed. The First Officer votes the table's
centre: the mean of the others, plus cohesion. A crisis term
reads the damage report for the whole table: it rises with
system damage and with a short parts locker on a worn ship,
prices candidates by parts supply, damps the backtrack
penalty, and prices time at sea. A refused motion falls to the
whole table's aggregate prices, not to the refusers'
plurality.

Judgment calls. The sitting reads the actual store counters,
not believed stores; rationing already reads the counters the
same way, and a believed-stores model stays deferred with
admissions. The vote draws no randomness: it is a pure
function of run state, so the council stream order and replay
are untouched. When no council can sit (an ended ship, or the
stores test harness), the voyage falls back to the legacy
pick rule, and the chronicle records the fallback as such. The
kernel refuses a course decision that is off the chart or
recorded twice for one stay, at the point of mutation.

Chronicle and viewer. A new event type, `course_decided`,
carries the proposer, the chart with leg days, the captain's
motion, each officer's one-clause leaning, the vote count, and
the chosen port; a `council_finding` with kind "course"
follows for the vote tokens. The chronicle prints course
decisions as Highlights lines. The header leg line names the
destination only once a decision exists, and the star map
draws the decided leg as a dashed line from the berth while
the ship lies in port. Nothing downstream assumes a
destination before the sitting.

Gates. `npm run check` green: typecheck on both configs, 104
of 104 tests across 13 files. Seed 42 at 4,320 ticks: 34,075
events, 51,192 decisions (unchanged from the pre-course build;
course decisions are council business, not crew decisions),
hash `07652594b1415cb0`. At 12,960 ticks: 98,819 events,
147,236 decisions, hash `47ecd59339a03280`. Replay is exact
across a course sitting (new long-span case in
test/replay.test.ts).

Constructed scenarios, both in test/course.test.ts. Seed 27:
the chart offers an industrial port at 12.4 days, a shipyard
at 13.1, and a market at 16.6. A sound council sails for the
nearer industrial port; the same ship with the reactor at
0.15 and two days of parts chooses the shipyard. Seed 21: a
sound council sails on to a listening post; the same ship
starving (food two days, water three, parts two, reactor
0.25) votes back to the agrarian port she came from, despite
the standing penalty.

Ninety-day fleet table. Columns: deaths, course sittings
(carried-refused), ports visited, repeat visits, distinct
ports.

| Seed | Deaths | Sittings | Visited | Repeats | Distinct |
|------|--------|----------|---------|---------|----------|
| 11   | 7      | 3 (0-3)  | 5       | 0       | 6        |
| 16   | 0      | 3 (0-3)  | 4       | 1       | 4        |
| 17   | 0      | 5 (5-0)  | 6       | 1       | 6        |
| 30   | 0      | 4 (1-3)  | 5       | 0       | 6        |
| 39   | 0      | 4 (3-1)  | 5       | 0       | 6        |
| 40   | 0      | 4 (3-1)  | 5       | 0       | 6        |
| 42   | 0      | 4 (4-0)  | 5       | 0       | 6        |
| 99   | 0      | 4 (2-2)  | 5       | 0       | 6        |

Sanity law holds across the fleet: every seed keeps making
port, no ship strands (fuel floor and drift rule intact), and
no ship ping-pongs between two ports. Every seed visits at
least four distinct ports, and the repeats are single returns,
not a two-port loop.

Balance caveat: seed 11. Seven deaths, all on one tick
(9698), from a `ship_lost` suffocation cascade. An A/B run
against the pre-course build (commit 745114b) shows the old
chooser drew more sabotage on this seed (108 events against
51) and no deaths; the divergence is a chaotic damage cluster
on days 40 to 50 that burned the parts locker from 45 to
about 1 while life support later failed, not a systematic
council defect. Every seed-11 sitting's arithmetic was
defensible, and the collapse completes mid-leg on any leg
over about 15 days. The frequency-law test in
test/council.test.ts was amended to carry the carve-out
plainly: per-seed deaths at most 2, or all deaths on a single
tick with a `ship_lost` event that tick (the ending firing,
not an ordinary-mortality leak). The carve-out is kept: on
Oct 27, 2026 the maintainer ruled the cascade a legitimate
rare ending; it is recorded here so the judgment stays
visible.

Still deferred: the distress-call and diversion half of the
course jurisdiction (waits on the rescue chain); admissions;
a believed-stores model for the table.

## Crew chatter, built (Oct 18, 2026)

The maintainer asked whether there is any crew chatter. There
was none: socialising and gossip existed as mechanics, gossip
moved suspicion in silence, and only the tipping moment
printed. This build gives the crew words, on three surfaces:
the full chronicle (quoted speech), the highlights (notable
lines only, capped), and the deck (text speech bubbles over
the speaker, the line rendered to a canvas once on its event).

Model. A new module, src/perception/speech.ts, is called from
the three places talk already happens: spreadGossip (after a
real transfer), resolveSocialize (shared leisure), and meal
table pairs. It reads state and the event log, composes a line
from templates in CONFIG.chatter.templates, and writes only
chatter events plus a per-person last-spoke tick. Testimony
speech rides the council's existing testimony computation:
each statement now carries present/tag/variant, the accused's
denial is emitted as a statement of its own, and a witness who
was present, suspected the true culprit, and named someone
else is recorded as a withheld statement.

No randomness. Speech selection draws no RNG stream at all:
gates and variant picks are pure hashes (hash32 over tick,
speaker, listener, subject). A new stream was considered and
rejected: any stream draw inside gossip or socialising would
shift every later draw on that stream and churn every
existing hash for zero benefit, since speech must not change
outcomes anyway. Proven by test: seed 7 over 30 days with
CONFIG.chatter.enabled on and off produces identical event
streams (chatter events aside), identical decision logs, and
identical beliefs. Decisions on seed 42 are unchanged at
51,192 over 4,320 ticks.

Dosage, tuned on seed 42 and measured across the fleet at 90
days. Full chronicle chatter: 2.7 to 4.1 lines per day.
Highlights chatter: 0.9 to 1.8 lines per week, under a hard
renderer cap of 1 per day (CONFIG.chatter.highlightsPerDay).
Tagged lines: 23 to 62 per 90 days. The tuning that got there:
a per-speaker cooldown of 288 ticks, a ship-wide minimum gap
of 12 ticks between any two lines (without it, a meal window
produced a chorus), voyage countdown talk demoted to filler
behind two extra gates (it is true every day, which is why it
must be rare), and the rehearsal window narrowed to 0.05
(gossip only transfers suspicions of 0.48 and up, so a wider
window marked nearly every spoken suspicion notable).

Watcher grades. [not true]: a spoken suspicion names someone
outside the culprit set the log itself records (sabotage
culprits and thieves so far). [lie]: the speaker is in that
set and points elsewhere; a culprit's inquiry denial is
graded the same way. [kept quiet]: the withheld statement
above. Testimony claims are graded against the sitting's
recorded truth where the sitting has one.

Judgment calls, recorded plainly:

- The truth line replaces the older parenthetical that kept
  truth apart from the verdict. It prints in both chronicle
  modes, but under the chronicle's knowsTruth setting, like
  the parenthetical it replaces and like every watcher tag:
  with the truth setting off, the chronicle is the crew's-eye
  log and carries no watcher knowledge at all. The line
  prints only where the sitting's record carries a truth
  (truthKnown: an inquiry into a death, a sabotage, or a
  theft with a recorded culprit or a recorded absence of one).
  Discipline sittings and certified accusations print nothing:
  there is no ground truth to grade them against, and the log
  does not invent one.
- Accusation reasoning is exposure, not new mechanics. Means
  is the accused's repairSkill, the same number the accusation
  computation already weighs; motive is the hottest grudge
  heat the accused holds; opportunity is the accuser's
  suspicion value itself, which is the presence-evidence
  composite after the sabotage plot's evidence pass. The
  three ride the accusation event payload.
- Speech text is composed twice from one payload: the
  chronicle and the viewer's bubble both call the speech
  module's text builders, so the deck and the log cannot
  disagree about what was said. The event carries parts, not
  prose, so a re-render in another voice stays possible.

Hash shift, stated honestly: chatter events enter the event
log and therefore the stream hash. Seed 42: at 4,320 ticks,
34,075 events and hash 07652594b1415cb0 before; 34,182 events
and hash 8db3af2e6030063a after (107 chatter events in the
span). At 12,960 ticks: 98,819 events and hash
47ecd59339a03280 before; 99,194 events and hash
d77edb7898a4b6fd after. Decisions are unchanged at both spans
(51,192 and 147,236). Every non-chatter event, decision, and
belief is unchanged, per the no-feedback test above. Replay
across chatter stays exact (test/chatter.test.ts).

## Crew skills, built (Oct 18, 2026)

The chapter is built. Seven disciplines (Engineering, Life
Systems, Hydroponics, Medicine, Fabrication, Operations,
Husbandry) live on a skills ledger (src/world/skills.ts) in the
harm ledger's shape: state changes go through one booking door
(bookXp), in integer milli-XP, at the moment work happens, and
booking draws no randomness. Levels run 0 to 10 on a growing
threshold curve (20k milli-XP to level 1, 1,330k to level 10).
One level is worth 0.14 in the formulas that used to read the
flat number, the scale the old role table was drawn at: a chief
engineer boards Engineering 7 and reads 0.98, as the flat
number did. Boarding levels live in CONFIG.skills.boarding;
the chapter's examples hold (chief engineer Engineering 7,
medic Medicine 6, cook Husbandry 6 and almost nothing else).

The flat repairSkill is removed, not blended. Every formula
that read it reads a discipline level now: repair and
maintenance amounts and the repair gate (affinity plus level 2,
or level 6 with no affinity, so a mastered hand can repair what
her role never listed), treatment candidate pricing and the
healing factor (priced by the actual treater: the member on the
treat action, else the medbay-affinity hand standing in the
medbay), work accident danger (relieved by the practised
discipline of the room's most dangerous system), the accusation
means term (the accused's best discipline), council
qualification, and inquiry testimony weight.

Booking doors: maintaining a system books its discipline,
repairing books it again at the repair rate, a repair that drew
parts books Fabrication at a fifth share, finishing a repair
books a completion bonus, treating books Medicine scaled by the
patient's severity, carrying the wounded books Medicine to the
carrier, meal service books Husbandry to the server, a port
resupply books Husbandry to the quartermaster, and room work
with no system books the room's trade. Difficulty multiplies
the base lesson (routine 1, damaged 1.75, red 2.5). Passion
and cover add their doubling on the routine lesson instead of
multiplying the difficulty: at routine work a passionate hand
learns at exactly double rate, and red work with a passion
learns at difficulty plus one, not difficulty times two. The
compounding was measured minting level 4 in a secondary inside
90 days; the additive form is what the chapter's numbers
describe. Failure books at half rate (work accidents book the
lesson this way). Mentoring books a fifth of a lesson to
juniors standing with the worker, but only from lessons worth
watching: repairs, treatments, completions, and session-opening
work. Routine ticks do not radiate. Measured before the
restriction, a patrolling officer reached Life Systems 4 from
zero in 90 days by standing in rooms; watching is not doing.

Rust runs in the skills step at day boundaries: past a week's
grace since last practice, a discipline above its boarding
level loses 250 milli-XP a day, and stops at the boarding
floor. Marks cap the effective level (markCapLevel 5: a ruined
hand caps Engineering and Fabrication, a lost eye caps
Operations) while the true ledger keeps accruing underneath;
every formula and display reads the effective level.

Believed skill lives in the existing belief stores, per
observer per subject per discipline. It starts offset from the
truth by up to two levels (self-belief is always exact), and
corrects only through witnessed work: co-present witnesses move
toward the truth by at most half a level per gated booking,
exactly on a witnessed level-up, and down to the truth on a
witnessed public failure. Council appointments judge candidates
by the appointer's believed skill, so a captain who has it
backwards seats the worse hand; test/skills.test.ts constructs
exactly that (the captain rates the cook Engineering 9 and the
engineer 1, the chief engineer dies, and the cook takes the
seat). Testimony at an inquiry is weighted by the officers'
believed expertise in the cause's discipline (death to
Medicine, sabotage to Engineering, theft to Husbandry, the
rest to Operations), on top of the existing trust discount.

Generation keeps a seed's identity. Removing the flat number
removed its draw (role.repair plus rng.next() times 0.1, one
draw per member), and the first build quietly named a
different crew on every seed: traits and beliefs reshuffled,
and seed 42's first sabotage slid past day 30, which two suite
tests caught. The passion now draws in that slot, one draw per
member at the same stream position, and the generated roster
(names, traits, needs, beliefs, rivalries) is byte-identical
to the pre-skills build on seed 42. The minor discipline and
the believed-skill offsets draw after every identity draw, on
the same stream, where nothing downstream consumes it.

Tuning, measured over 90 days on the daily seeds plus 99.
Level-ups per run: 15 to 23. Best gain per member per seed:
+3 at most, with one named edge below. Cross-training from a
boarding level of 1 or less: at most +1 anywhere. Nobody
reaches 10 in anything they did not board near (nobody reaches
10 at all in the window). Deaths: 0 on all eight seeds. Two
structural notes the table makes plain. First, growth follows
the work the engine assigns, not the role's title: Life
Systems runs hot because four roles hold the water recycler in
their affinity, and the engineering department's growth splits
between Engineering and Life Systems by which system is
hurting. Second, Husbandry has few teachers in this engine:
meal service (the cook) and the resupply manifest (the
quartermaster). Meal service is sized so a working cook gains
about a level of Husbandry in 90 days; the quartermaster's
growth rides Life Systems, their affinity work, and their
Husbandry moves by points, not levels. The named edge: seed
42's cook gains Life Systems +4 in 90 days (2 to 6). Passion
and role affinity coincide there on the fleet's most-damaged
system, worked daily; the cook ends as the ship's best life
support hand, one level over the chief engineer, who boarded
at 5. The test ceiling records the shape: 3 anywhere, 4 only
for a passion. If the maintainer wants the chapter's two-to-
three to bind secondaries too, the recycler's damage rate is
the dial, not the booking rates.

Viewer: the roster row carries one number (the primary
discipline's short label and level) beside the title, and the
person card gains a Skills section: the passion in prose, a
row per held discipline with the true level, progress toward
the next, any mark cap, and the captain's believed level where
it differs from the truth by a level or more. Level-ups print
in the chronicle as minor milestones and never toast: the
alert whitelist was not extended. The epilogue line of the
chapter is not built: no epilogue surface exists in the engine
or the viewer yet, and the ledger carries the numbers it will
read (peak level and boarding level per discipline) when
endings land.

Judgment calls, recorded plainly:

- Fabrication has no system of its own in this engine. It
  books from work that teaches it: repairs that draw parts
  from the locker, at a fifth of the repair's lesson.
- Cover (the necessity rate) has two doors: holding an acting
  council seat whose portfolio covers the discipline, or
  working a system while no able native affinity holder is
  aboard. The council public record now carries the acting map
  the cover test reads.
- Believed skill is updated at the booking moment, inside the
  ledger's door, not in a separate perception sweep over work
  events. Same store, same witness rule, one less pass that
  can drift from the work itself.
- Treatment healing reads the treater's Medicine through the
  skills ledger, under the health chapter's own medic and lay
  factors, which still apply beneath it.
- Passengers and synthetics holding levels stay deferred, as
  the chapter leaves them: the ledger keys on the person, not
  the role, so nothing in the booking path assumes a role.

Hash shift, stated honestly: skills change behaviour wherever
a formula read the flat number, and hashes move. Seed 42: at
4,320 ticks, 34,182 events and hash 8db3af2e6030063a before;
34,191 events and hash f7bdb20808fbe3e1 after, with decisions
unchanged at 51,192. At 12,960 ticks: 99,194 events and hash
d77edb7898a4b6fd before; 99,915 events and hash
3736cecd3770bb44 after. The 90-day drama on seed 42: sabotages
100 to 91, system repairs 100 to 90, injuries 2 to 2, deaths
0 to 0, accusations 1,461 to 1,385, grudges 88 to 82, lasting
marks 1 to 1, plus 18 level-ups that did not exist before.
Replay stays exact (test/replay.test.ts, test/chatter.test.ts)
and the full gate is green: 128 tests, typecheck clean on the
engine and the viewer.

## The accusation economy, cooled (Oct 27, 2026)

The five-year watch on the old build named the defect plainly:
46,314 accusations over five years, about 25 a day at day 90
and still 25 a day at year five, and every ordered pair aboard
over the accusation line (measured mean suspicion 0.90 of 1 at
day 60 on seed 42). The rate was not drama; it was cooldown
ceilings dividing the crew count. Four changes, each aimed at
a mechanism rather than the symptom:

- A public accusation is now heard in the room where it is
  spoken. The suspicion it plants and the trust it costs reach
  only the crew present, the same presence law gossip already
  obeyed; it used to top up all ten other crew ship-wide.
- A spoken claim holds its target for a full day (the public
  cooldown, 36 to 144 ticks): a person is publicly accused at
  most once a day, not four times.
- Sabotage evidence names only the near. A suspect must have
  been seen in the room itself or the room next door inside
  the witness window; distance beyond that is an alibi. The
  act casts one fixed weight of suspicion per observer,
  divided among the near suspects by squared evidence and by
  prior distrust. It used to pay nearly full weight to every
  suspect at any distance, so each act sprinkled the whole
  ship.
- Gossip attenuates (gossipFidelity 0.8): a listener catches
  at most four fifths of the level the speaker holds, so
  rumour fades hand to hand unless evidence refreshes it.

Two tunings ride along: suspicionBase 0.34 to 0.55 (the act's
whole weight, before division), and suspicion decay 0.001 to
0.0007 a tick, about 10% a day, so a repeat offender's pattern
accumulates across a fortnight while a quiet month still
clears the air.

Measured on the shipped path, seed 42: 90 days carry 11
accusations (was 1,385), focused on three people (7, 3, 1),
with 22 sabotages, 9 council sittings and 3 sentences, and no
pair saturation at day 90. The daily seeds were re-vetted on
the new physics (30-day voyages, drama scored as before):
seed 11 scores 23, 16 scores 19, 17 scores 8, 30 scores 18,
39 scores 20, 40 scores 17, 42 scores 12. No ship lost, no
deaths, no runaways; the list stands. Month one of a voyage
is now sabotage-and-council led, and accusations typically
land from the second month, as a case builds.

Known open thread, recorded rather than smoothed over: at
year scale the society still warms. Seed 42's year carries
2,341 accusations, ramping over about five months to roughly
10 a day, as trust damage (which has no recovery term)
accumulates grudges. A trust-cooling term was tried at two
rates and rejected on measurement: at both, the cooling
outran the ship's friction and no grudge ever formed. The
vent for the year-scale heat belongs to the council, whose
findings should settle the ship's suspicion of the accused;
that is future work in the council programme, not another
suspicion knob.

The seed 11 carve-out above is settled by the maintainer's
ruling of Oct 27, 2026: kept.

## One frame, both decks (Oct 28, 2026)

The deck presentation changed on the maintainer's direction: the
Upper/Lower switch is gone. The Decks view is a cutaway: both deck
plans on one canvas, stacked with a 12px structural gap, each
plate-labelled DECK 1 and DECK 2 in its top margin. The view
buttons are camera modes now: Decks, Hull, Chart.

Why: switching decks to follow the crew was the viewer's standing
friction, and the interesting thing about a two-deck ship is the
life moving between the decks, which a switch always hid. A
crewmate riding the lift now reads as travel inside one frame.

How it is built, and what it must not cost: the frame's movement
and staging update is one shared system, untouched. The painting
passes moved into a per-deck method the frame runs once per deck
under a translate; bodies, bubbles, sparks (now tagged with their
deck), staged events and the alert flash are each drawn only in
their own deck's pass, in that deck's coordinates. The crew's
animation is therefore the same code on the same numbers, drawn
twice over two plans instead of once over one: the maintainer's
standing rule for this pass was that crew animation and the crew
cards are good as they are and must not regress.

The canvas also scales to its stage now, in whole multiples only:
the art is pixels, and an integer scale keeps every pixel the same
size on a large screen instead of the ship sitting small in black
space. Below 1x the stylesheet's shrink-to-fit still applies. The
hull exterior keeps its one-plan-tall canvas; the chart reads the
taller canvas and centres itself.

The focus deck survives as a concept (keys 7 and 8, the minimap's
frame and tap, which deck's shake the scene takes, telegraph
priority), but it switches nothing visible by itself anymore.
Single-deck presentation is retired from the renderer, not parked
behind a flag.

## One hull, and an interior polish pass (Oct 28, 2026)

The maintainer's verdict on the shipped cutaway: the decks still
looked silly, two tube designs. He named a ship-life sim whose
ship design he likes (a side-view cross-section: one trussed
structure of framed modules, nothing capsule-smooth); the repo
names no games, per his ruling the same night, so the study stays
in the session notes and only its lessons land here.

The cutaway now paints ONE angular hull beneath both decks
(renderCutawayHull in viewer/src/deck.ts): faceted bow, plating
seams, seeded top-edge fittings (a mast, a dome, a dish block),
an engine block at the stern on the hull's own midline, and the
band between the decks dressed as a spine: keel beams, ribs,
tanks, and the lift shafts piercing it. The per-deck silhouettes
are gone (renderStatic paints bare interiors), and the deck wear
layers keep their hull-band grime with the engine soot parked
offscreen, since the engine belongs to the shared hull now.

The interior lift rides along: the floor palette is separated by
kind and brightened (bridge slate, quarters plum, mess warm
wood, medbay pale, cargo olive), the structure darkened with
truss ticks so unroomed space reads as bracing, a baked light
pool and inner shadow per room, a plate accent tick in the room
kind's colour, and small prop redraws (bunk blanket stripe,
crate braces, a mess table centrepiece). Verified by night and
day screenshots before shipping; the crew animation and staging
systems are untouched.
