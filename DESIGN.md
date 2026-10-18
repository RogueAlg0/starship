# Starship Crew Simulation — Design Doc (v0.1, private)

Started: October 18, 2026. Status: private project. Nothing public, nothing
upstream, until there is something real and a fresh decision is made.

## The idea

A deterministic simulation of a procedural starship and the crew who live
aboard it, in the depth of dunya's civilization and squad simulations
(see `~/workspace/research/dunya-engine-notes.md`).

The player does not play. Like dunya's civ and squad sims, there are no
controls. The player picks a seed and witnesses. The seed chooses the ship,
the crew, and the fate. The product is the chronicle: the ship's log, which
records what truly happened while the crew acted on what they believed.

## Ingredients, and what each one contributes

- Space Haven: a buildable, procedural ship; crew needs; life aboard as the
  core loop of attention.
- Star Trek: one ship, one named crew, a voyage made of episodes; the ship
  as home.
- Vanguard Galaxy: a procedural galaxy to wander; the ship as a small life
  moving through a large indifference.
- dunya's village sim: agents who decide from beliefs that can be false, so
  thefts, grudges, accusations and loyalties generate themselves; culture,
  needs, weather, and a world that pushes on people.
- dunya's squad sim: detail at the level of body parts and single seconds;
  proof the pattern forks to a new domain without breaking.

The gap this fills: Space Haven's crew are mood machines with no false
beliefs. Vanguard's crew are stat cards. Nobody has put beliefs-driven
drama aboard a procedural starship with a truthful chronicle over it.

## Design pillars

1. Witness, do not play. No controls, no orders, no interventions. The
   player's only act is choosing the seed.
2. Beliefs, not truth. Crew decide from what they believe about the world
   and each other. Beliefs can be wrong. Wrong beliefs incite incidents.
3. The log never lies. The event log records ground truth. Drama comes
   from the gap between the log and what the crew believes.
4. Every system must earn a chronicle line. If a system never produces a
   log entry that makes the witness feel something, it does not ship.
5. Determinism is the religion. A run is its seed plus its config. Same
   seed, same ship, same story, bit for bit, provable by replay.
6. Speed is a feature. The reference sims run a 30-day village (4,320
   ticks, about 103,000 events) in roughly 11 seconds headless. Our sim
   must stay in that class: fast enough that a witness can run a whole
   voyage, read the log, and immediately run another seed. Every run
   reports its ticks per second; a change that makes runs crawl is a
   regression, not a tradeoff.

## Kernel blueprint (pattern, clean-room implementation)

Learned from dunya's design; implemented in our own code, never copied.
Dunya is unlicensed, so its code is not ours to reuse. Its ideas are.

- Fixed-order tick loop. The engine is the only writer of world state.
- Agents never touch state and never see truth. The engine offers each
  agent a list of candidate actions; the agent picks an index, choosing
  from a beliefs-only view. Every pick is logged.
- All randomness from named, per-subsystem RNG streams, each seeded
  independently, so a new draw in one system never shifts another
  system's future.
- Every state change appends to an event log. Log lines fold into a
  stream hash. One number names a whole run.
- Purity is enforced, not hoped for: no wall clock, no ambient randomness,
  no platform imports inside the engine. A static scan proves it.
- One engine, every home: because the kernel imports nothing
  platform-specific, the identical engine runs offline in a headless CLI
  and in a browser viewer, exactly like the reference sims (in dunya,
  only the two CLI files import node modules; everything else is pure).
  The viewer is a separate layer added later; it never touches engine
  code paths.
- Per-tick invariants: conservation ledgers, occupancy, value ranges.
- Replay: seed plus decision log reproduces the event stream exactly.
  Divergence is an error, not a shrug.
- Tests before features: determinism, purity, and replay suites are
  green before the first crew member exists.

## The world (sketch)

- A procedural ship: decks, rooms, and systems (power, life support,
  engines, sickbay, mess, quarters) laid out from the seed.
- A crew of about a dozen in the first slice: names, roles, traits,
  skills, needs, relationships, and beliefs about each other.
- A procedural galaxy around them: star systems, voyage legs, ports.
  The ship moves; the life aboard continues while it moves.
- Incidents incited from inside: grudges, rumours, favouritism, fear.
  The first incident generator is grudges that incite sabotage.
- Sickbay uses a body and wound model in the squad sim's spirit:
  injuries per body part, treatment, healing over time, lasting marks.
- The world pushes on the crew (from the civ-systems research,
  `~/workspace/research/dunya-civ-systems.md`):
  - Shipboard weather: a small state machine on its own RNG stream
    (calm, solar wind, radiation storm, debris field), rolled on a fixed
    cadence and corrected by physical constraints. It does nothing
    directly. It acts through multipliers everywhere else: sensor range,
    hull wear, EVA risk, mood, accident risk.
  - Shipboard seasons: the voyage leg is the season. A leg has a length, a
    resupply point at the end, and stores that only shrink. Winter aboard
    ship is the last third of a long leg with the ration math visible.
  - Harm is statistical: accident risk over the work actually done,
    multiplied by conditions (storm, fatigue, hurry), landing on the body
    and wound model. Every injury is booked to a cause ledger, which is
    what a later inquiry reads.
  - Evidence has a half-life (the civ sim's best mechanic, adopted as a
    pillar-grade rule): the world writes traces with kind-specific
    lifetimes (sensor logs, camera footage, physical traces, overheard
    words), and the world also erases them (radiation storms scrub
    sensors, airlock cycles purge residue, logs rotate). Crew and
    investigators form beliefs only from what survived to be found.
    Design the evidence lifetimes and the erasure weather first, and the
    drama builds itself.
  - Ship's night (future, engine): the village sim's light is engine
    state, not scenery: after dark, fewer villagers are awake to see a
    crime, so notice chances fall. Our analog: presence evidence should
    thin on the night watch, when most of the crew sleeps in quarters
    and the corridors stand empty. Sabotage at 03:00 is a different act
    from sabotage at noon, because almost nobody was there to almost
    see it. The viewer already renders the day/night cycle as
    presentation; the engine version is design-future, not built.

## The galaxy around the ship

From the Vanguard Galaxy and Starsector research
(`~/workspace/research/galaxy-systems-vanguard-starsector.md`). The ship
is one crew among many simulated actors. Nobody controls any of them.

- Procedural factions: generated per seed (names, temperaments, territory,
  relations), simulated on the same kernel as the crew. Factions hold
  beliefs, keep grudges, and act on both.
- The Conquest rule, adapted from Vanguard Galaxy: every system has a
  fleet strength, a reinforcement rate, and a controlling faction. On a
  fixed cadence, control can flip by strength and gate adjacency. Factions
  expand, shrink, and can be eliminated with no witness present. Every
  flip is logged with its reasons. The galaxy's wars write themselves.
- Patrols run on suspicion, adapted from Starsector: a patrol acts on what
  it believes (transponder identity, cargo suspicion from behaviour), and
  a perception once logged cannot be un-seen. Law enforcement becomes a
  friction and incident engine that needs no scripting.
- Convoys are physical: a lost convoy genuinely starves its destination,
  which cascades into shortages, falling faction scores, and bounties.
- Bounties are stories, not spawns: a person bounty is posted because of a
  real prior event (a raid, a survivor's testimony). The poster's
  description of the target is generated from the poster's beliefs, which
  decay and can be wrong. Hunters can kill the wrong captain. The
  chronicle narrates both sides.
- Missions are the galaxy's paperwork: delivery, survey, procurement, and
  escort contracts generated from live world state (shortages, wars,
  stranded crews), taken by NPC captains as often as by the witnessed
  ship. A mission board is a window into what the galaxy needs.

## Crew flow: how new crew arrive (designed, post-v0)

Ships are not closed casts. Vacancies open through deaths, injuries that
retire, and crew who quit at port when morale and trust collapse. New
crew arrive through chains, each an event sequence on the same kernel:

- Port hiring: at a resupply stop, candidates sign on. Who applies
  depends on the port, the faction, and the ship's reputation as it is
  believed to be, not as it is.
- Rescue: a distress call or a wreck yields survivors. They arrive
  grateful, traumatized, or lying. A rescued stranger is a suspicion
  engine: they may be exactly what the bounty posters describe.
- Stowaway: discovered cycles after departure, in cargo or at an
  airlock. The crew decides from beliefs: brig, adopt, or put off at
  the next port. The stowaway may be running from someone, which
  imports that someone into the story.
- Passengers who stay: a ferry or escort mission ends with a passenger
  asking to sign on. Missions become recruitment by accident.
- Transfer and imposition: a faction assigns a liaison, or an allied
  ship exchanges crew. An imposed officer arrives with loyalty pointing
  off-ship, which the whole mess hall can feel.
- Birth: on long voyages, bonded pairs have children who grow into
  crew. The slowest chain, and the one that makes a long run a saga.
- Manufacture: the ship builds or wakes a synthetic crew member at a
  resource cost. The crew's beliefs about what it is become the story.

Every arrival enters with empty relationships and a past the others
cannot see. The chronicle introduces them the way the crew meets them:
as a name and a knock on the airlock door.

## Consequences, death, and endings (designed, post-v0)

Point three of the v0 honesty list, fleshed out: in v0 nobody can die
and nothing can end. This layer fixes both, using the village sim's two
best tools: statistical harm booked to a cause ledger, and an inquest
that judges from beliefs.

### Harm is modeled, never rolled out of nowhere

No crew member dies because a dice said so. Harm arrives through chains
the witness could have seen coming:

- Accidents: risk per tick of real work, scaled by the work's danger,
  conditions (radiation storm, darkness of a failed light circuit),
  fatigue, and hurry. The village model: risk over the tiles actually
  walked; ours: risk over the tasks actually done.
- System cascades: a system at low condition stops being a repair bill
  and starts being a hazard. Life support failing means air quality
  falls shipwide; a reactor in the red leaks radiation into engineering;
  a sabotaged water recycler left unrepaired becomes thirst, then
  sickness. Sabotage does not kill. Sabotage plus neglect plus time can.
- Sickness: from bad water, bad air, crowding, and contact with whatever
  the last port or rescue brought aboard. Spreads by co-location, the
  way beliefs do.
- Violence: grudges have a far end. Sabotage is the middle of the road,
  not the end of it. A crew member whose grudge, traits, and despair all
  peak can attack the person they blame. Rare by design, and the
  chronicle should make it feel rare.

### The body, at ship time

Adapted from the squad sim's wound model, slowed to ship time: wounds
per body part (head, torso, arms, legs), each with severity, bleeding,
and infection risk. Bleeding runs in minutes and hours, not seconds.
Treatment is work: the medic's skill, the medbay's condition, and who
carries the wounded there all matter. Healing runs in days. Lasting
marks are real: the lame leg, the ruined hand, the lost eye, and the
career that quietly changes shape around them. A crew member can
survive an incident and never be the same crew member again.

Death comes from accumulated state, the way the village keeps it: total
health collapse from bleeding, infection, suffocation, radiation, or
untreated sickness. Every point of harm is booked to a cause in a
ledger at the moment it lands. The ledger is the truth about how
someone died, and it is written before anyone forms an opinion.

### The inquiry

Every death triggers a board of inquiry, the village inquest in ship
clothes. Witnesses testify from their belief stores: what they saw,
what they heard, discounted by how much the hearers trust them.
Testimony can omit, distort, and fabricate, and a guilty party can
offer up a scapegoat, the least trusted non-kin soul aboard. The board
finds a cause and, where it believes there is one, a culprit. Its
finding can be wrong. The chronicle prints both: the ledger's truth in
its own marker, and the board's verdict as the crew received it.

Consequences flow from the finding, not from the truth: the accused is
confined to the brig, or put off at the next port, or quietly forgiven
by a captain who does not believe the board. The dead person's friends
inherit the grudge the way the village inherits feuds. A wrongful
finding is not a bug in this layer; it is the layer working.

### Endings

A run ends when the story does. The designed endings:

- Arrival: when voyage legs exist, a final destination ends the
  voyage. The epilogue is a closing log entry: days sailed, the crew
  who arrived, the crew who did not, the grudges still open.
- Ship lost: life support or reactor cascade reaches the point of no
  repair. Abandon ship if pods and time allow; who reaches the pods is
  decided by where people are and what they believe is happening. The
  survivors become a rescue chain for some other ship, possibly one the
  witness meets in a later seed's galaxy.
- Crew collapse: too few able crew to run the ship. She drifts. The log
  continues on emergency power for a while, recording a quieter and
  quieter ship, and then stops. The last entry is the ship's, not a
  person's.
- The open run stays possible: a witness who never wants an ending can
  sail a healthy ship indefinitely. Endings are attractors, not timers.

### Frequency law

Death is an event of the month, not of the day. Targets for tuning: a
typical 90-day voyage sees zero to two deaths, each one traceable in
the chronicle to a chain a witness could recount. If a death cannot be
explained from the log, the model is wrong, not the luck.

## Construction and refit (future, engine system)

**Status: future design, post-v0. Not built.** Recorded Oct 18, 2026.

In the reference civ sim, the villagers build their village: the
place visibly grows because the people in it do the work. The ship
needs its long-form analog, because a witnessed ship should also
change under its crew's hands over a long voyage.

The shape of it: a hull is generated with some raw frame sections
aboard, unfinished volume inside the silhouette. On long voyage
legs, engineers can build a raw section out into a finished room
over days of witnessed work: first the frame is closed, then walls
and a door go in, then the fit-out (floor, fixtures, the room's
defining equipment), and only then is it a room the sim can use, an
entry in the room graph like any other. Each stage is work like any
other work: crew walk to the section, labour ticks accumulate, and
the build consumes stores (bulkhead material, fixtures, power
budget), so a ship that builds is a ship that must have stocked for
it at the last port. The chronicle narrates the stages the way it
narrates everything else; a finished room is a small ceremony.

Ports offer the other half: refits. Docked time and port stores can
swap a room's kind (a cargo bay becomes a second hydroponics),
install a system the ship generated without, or strip a room back
to frame to make space. Refits are paperwork and labour, witnessed
the same way.

Open questions for when this is scheduled: which rooms a given hull
may grow (adjacency and hull stress as quiet constraints), whether
construction accidents join the harm model, and how the deck
derivation in the viewer grows a room mid-run (the floor plan is
derived per ship today; a growing ship needs it derived per era of
the ship). None of this touches v0.

## Getting around, and getting word around (future, engine notes)

**Status: future design, post-v0. Not built.** Recorded Oct 18, 2026,
at the user's direction.

### EVA: the slow march, in a suit

The squad sim's tension is bodies crossing ground slowly. Ours is
the spacewalk: external systems (engines, comms, hull) are repaired
by a suited crew member who exits the airlock and moves slowly,
tethered, along the hull, while the clock runs. The maneuvering
itself is the tension, the direct analog of the march. EVA
accidents join the harm model when this is built.

### Distance costs time

Crossing the ship should take real ticks, so where the crew happen
to be when something fails decides the shape of the next hour: help
that is near arrives, help that is far arrives late, and late help
is a story. The engineer asleep two decks from engineering is a
different incident from the engineer awake beside the reactor.

### Communications and runners

In the squad sim, help calls are asymmetric: one side radios
instantly, the other sends a runner, a physical man who must cross
the ground; the call is heard only when he arrives, and a runner
can be given up on. Shouts carry by proximity; radios have limited
reach.

Aboard ship, the comms system is the instant channel: the captain's
decisions, accusation broadcasts, repair coordination. With comms
damaged (a prime sabotage target), the ship falls back to runners:
crew carrying word between rooms, so information moves at walking
speed; rumours and accusations spread by voice range, a room and
its neighbours, instead of shipwide; repair coordination and
inquiry testimony degrade. Between ships, signals take days: a
distress call is answered as it was described, not as things now
stand. Stale information is the galaxy's normal state, and it pairs
with the bounty design, whose posters are beliefs all the way down.

## Away missions (future, major engine system)

**Status: future design, post-v0. Not built.** Recorded Oct 18, 2026,
at the user's direction. This is the big one: a ground layer on the
same kernel, not a viewer trick and not a minigame bolted on.

The structure is Star Trek's: ship life is the series, away missions
are the episodes. Inside a voyage, the ship puts a landing party on
a procedural ground map (a planet surface, ruins, a wreck, a
colony), rendered top-down like the deck, and the witness watches
the squad sim's pleasures in our clothes: a map worth reading, slow
deliberate movement and positioning, and ground that changes under
fire.

- The away team is 4 to 6 drawn from the actual roster. Their faces,
  traits, skills, and grudges come down with them; the party is the
  crew, not a separate cast, and what they think of each other
  matters more, not less, at the bottom of a gravity well.
- Movement is the squad march: deliberate, positional, slow enough
  that a bad position is a decision the witness watched happen.
  Hazards are environmental first (terrain, weather, whatever lives
  there, whatever the wreck is leaking) and sometimes combat, using
  the body and wound model from the consequences chapter: harm per
  body part, treatment as work, marks that last.
- Destruction is real and the map remembers it for the rest of the
  mission: cover breaks, structures burn, a wall the party sheltered
  behind in the first hour is a gap in the third. The ground keeps
  the score the way the ship's cause ledger does.
- The party goes down on beliefs. Ship sensors believe there is a
  distress call, or ruins, or nothing at all, and sensors can be
  wrong, for every reason the evidence rules already give: range,
  storms, decayed traces, a poster that lied days ago. The mission
  the crew planned is the one their beliefs described; the ground
  holds the truth.
- Comms obey the runner and radio law: range and delay between ship
  and surface, and beyond range the party is on its own: no
  coordination, no testimony, no rescue that knows where to land.
- What happens down there flows back aboard, because there is one
  crew and one chronicle: the wounded go to sickbay and the body
  model takes them from there; the dead go to an inquiry, and to
  the grudges of the friends who stayed up ("you sent him down" is
  a grudge with an address); salvage, samples, and survivors come
  up into stores, sickbay, and the crew-flow chains.

Determinism is unchanged: the ground layer runs on the same
fixed-order loop, named streams, and event log, and an away mission
replays from its decision log like any other part of the voyage.

## Stores: the ship's economy (designed Oct 18, 2026, not built)

Playtest note (the user's, from watching v0): there is no economy.
Crew hunger rises, a crew member walks to the mess, hunger resets,
and nothing was ever spent. The ship has no pantry, so scarcity,
theft, and starvation, the village sim's whole engine of human
behaviour, cannot happen here. This chapter designs the fix. It
is the backbone several other chapters quietly assume: sabotage
needs a victim slower than a repair bill, the consequences chapter
needs its slowest cause, and the quartermaster needs a kingdom.

### The five stores

The ship tracks five stores, each a single number, each readable
at a glance in **days of supply** at current crew and consumption:
food, water, oxygen margin, fuel, and spare parts. Days is the
unit a captain watches; kilograms are bookkeeping underneath.

- **Food.** Grown by the hydroponics rig, eaten at meals. The
  pantry buffer is the harvest rhythm made visible.
- **Water.** Cycled by the water recycler. Losses are small while
  it works and permanent while it does not.
- **Oxygen margin.** Held by life support. Not a stockpile so much
  as a pressure: how long the air stays breathable if life support
  stopped now.
- **Fuel.** Burned by the engines over distance. In the ship-only
  sim it drains slowly under way; its real master is the galaxy
  layer (legs between ports are fuel decisions). Tracked from the
  start so the ledger is honest when ports arrive.
- **Spare parts.** Consumed by repairs. The quiet killer: a ship
  can have food for a month and still die because nothing aboard
  can be fixed any more. Parts are bought, salvaged, or, later,
  manufactured; they are never grown.

### The closed loop

Between ports the ship is a sealed terrarium. Per tick:

- **Production** is a rate per producing system, scaled by that
  system's condition (and strain): a rig at 60 percent grows 60
  percent of its rated food. Production is why system condition
  matters before anything breaks outright.
- **Consumption** is per living crew member: meals, water, air,
  plus flat ship overheads (leaks, losses, the mess's waste).
- The design balance for a healthy ship of twelve: food
  production near 105 percent of consumption, water and air
  slightly positive, so an undamaged ship slowly banks margin and
  any sustained damage shows up as a falling days counter within
  a day or two of ship time. Stores are sized at departure for
  roughly 30 to 45 days of buffer at full consumption, a voyage
  leg, not a lifetime.

Damage therefore becomes a **clock**, not a nuisance: a sabotaged
recycler reads as "water fails in nine days", and the crew can
watch the number fall in the stores readout while the repair race
runs. A radiation storm is a countdown with a sound.

### Rationing

When a store crosses its worry threshold, the captain (an agent,
deciding from beliefs and traits, never the player) may impose
rationing on that store: full, reduced, or strict. Rations stretch
the days counter at the price of hunger, thirst, morale, and
trust in command; lifting them early spends goodwill the other
way. Rationing is a decision other crew hold beliefs about, and
remember. The quartermaster administers stores and is the natural
lightning rod: every shortage has his name on it whether he
earned it or not, which the suspicion system will duly discover.

### Theft, hoarding, and the pantry door

Scarcity wakes the village's signature behaviours, reusing the
existing machinery (beliefs, presence evidence, evidence
half-life, accusations):

- **Theft from stores** when a store is rationed or low and a
  crew member is hungry enough, desperate enough, or angry
  enough: small amounts, taken at night or when the cargo bay and
  stores are unwatched. Theft leaves traces like sabotage does,
  and the inquiry machinery cannot tell a thief from a saboteur
  at a glance, which is rather the point.
- **Hoarding**: a frightened crew member quietly caches food in
  quarters. A cache discovered by the wrong person reads as
  proof of selfishness in a crisis, and travels by gossip (see the
  routine design: reputations move at meals).
- **The locked door**: at strict rationing the captain may post
  stores access control, which ends casual theft and begins
  resentment of a different flavour. Every cure is also a cause.

### Starvation and the slow cause

A store at zero stops being arithmetic. Missed meals deepen
hunger into weakness (the body model of the consequences
chapter): work slows, accidents rise, sickness finds purchase,
and sustained deprivation is a cause of death booked to the
cause ledger like any other, with the inquiry asking the only
question that matters: who saw the counter falling, and what did
they do. Dehydration and air run the same path on shorter fuses.
These are designed to be rare, slow, and always, *always*
explainable from the log: the frequency law of the consequences
chapter binds here too.

### Readout and alerts

The viewer gains a stores strip, always visible: five counters
in days (air as a margin state), each with its trend arrow. The
alert system's critical tier takes stores thresholds as first
class citizens: a store crossing into its last week is a major
alert, into its last three days a critical one that persists
like any emergency state. The captain's rations, when imposed,
are a chronicle headline and a banner state ("Water: strict
rationing, 6 days") so the witness always knows the terms the
crew are living under.

### Determinism and build notes (for when it is built)

Stores arithmetic is deterministic float-free bookkeeping on the
tick loop (rates in integer milli-units per tick, as the kernel
prefers). Production and consumption need no randomness at all;
the human decisions around them (rationing, theft, hoarding) go
through the decision source like sabotage does, on their own
named streams, so replay covers them exactly. New events: store
threshold crossings (worry, critical, empty, recovered), ration
imposed/lifted, theft and discovery, cache found. Chronicle lines
for thresholds and decisions; the per-tick arithmetic stays
silent, as it should.

### Open questions for the build

- Does the captain ration by fixed policy (thresholds in config)
  or by trait-weighted judgment per captain? Leaning: policy sets
  the menu, the captain's traits pick from it, so captains differ.
- Can crew draw emergency stores without authority in a crisis
  (a mercy theft the inquiry later forgives)? Rich, but scope it
  after plain theft works.
- Do passengers and rescued survivors eat at full share? (The
  crew-flow chapter says mouths arrive uninvited; the resentment
  writes itself. Decide when crew flow is built.)

## Version zero slice

One ship. Twelve crew. Needs and relationships. One incident generator:
grudges that incite sabotage. A chronicle renderer that turns the event
log into a readable ship's log. Determinism, purity, and replay tests
green. Nothing else.

The slice succeeds if a witness reads one run's log and cares about a
fictional engineer.

## Non-goals for v0

- No player controls or interventions of any kind.
- No combat system, no economy depth, no graphics beyond the chronicle.
- No public release, no upstream contact. Private until it is real.

## Open questions

- Tick scale aboard ship: dunya's village ticks at 10 minutes, the squad
  at 1 second. Ship life probably wants minutes, with incidents that can
  slow the chronicle down to the second when it matters.
- Crew size for the full vision: a dozen feels personal; fifty feels like
  the village. Decide after the slice.
- Voyage structure: continuous drifting, or episodes with ports between?
- Chronicle voice: plain log lines, or a log written in the ship's own
  formal register ("Captain's log" energy without a captain character)?
- A name for the project. Unnamed is fine for now.
