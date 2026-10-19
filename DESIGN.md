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

## Consequences, death, and endings (built Oct 18, 2026)

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

## Stores: the ship's economy (built Oct 18, 2026)

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

When a store crosses its worry threshold, rationing is proposed
and disposed of by the Ship's Council (see the council chapter):
the quartermaster proposes a level (full, reduced, strict) and
the council votes; the captain may impose rationing alone only
as an emergency act, and it expires within a day unless the
council ratifies it. Rations stretch the days counter at the
price of hunger, thirst, morale, and trust in command; lifting
them early spends goodwill the other way. Rationing is a decision
other crew hold beliefs about, and remember. The quartermaster
administers stores and is the natural lightning rod: every
shortage has his name on it whether he earned it or not, which
the suspicion system will duly discover.

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

## Ship archetypes: role and size (designed Oct 18, 2026, not built)

Today every seed produces the same kind of ship in different
clothes: the rooms, name, and crew vary, but nothing a ship IS
changes what it needs. Vanguard Galaxy (researched Oct 18, 2026;
~/workspace/research/vanguard-ship-crew-systems.md) shows the
discipline that fixes this: typed randomness. Its ships are a
matrix, 4 roles by 6 sizes making 24 classes and about 150 named
hulls, and everything downstream of the class (cargo, hardpoints,
crew capacity, even the size of the brig) is rolled inside the
class's grammar, never across the whole possibility space. This
chapter adopts that grammar at our scale and bends it toward
what our game is about: not loadouts, but people.

### The draw

Ship generation gains a first step. From the ship's signature,
before rooms or crew exist, the generator draws an **archetype:
one role and one size**. Everything else (compartments, systems,
roster, stores, voyage) is then generated conditioned on the
archetype's tables, which live in scenario config as data, the
way the village's norms are data. Same seed, same archetype,
forever; the archetype is part of the ship's signature and shows
in the viewer beside her name from the first frame.

### Roles (six)

- **Hauler** (trade). A working freighter on a paying leg. Big
  cargo, thin crew comforts, a captain who answers to a schedule.
  Characteristic scarcity: time and fuel. Characteristic sin:
  smuggling (cargo that is not on the manifest, and a quartermaster
  who knows).
- **Surveyor** (science). A survey circuit of uncharted systems.
  The lab and the sensor array are the ship; the crew is small,
  clever, and alone for a long time. Scarcity: company.
  Sin: the isolation vices, obsession, feuds in a closed room,
  and sensor ghosts argued about like theology.
- **Patrol cutter** (navy). A beat, a flag, and discipline.
  Armoury, a real brig, doubled security, stores kept like a
  parade ground. Scarcity: warmth. Sin: rigidity: discipline
  cases multiply, and the council sits often and hangs heavy.
- **Salvage rig**. Flies to dead ships and takes them apart.
  Grapples, a cutting bay, cargo full of other people's endings.
  Scarcity: luck. Sin: salvage law is mostly custom, and a rig's
  crew argues about what the dead owned, especially when the
  dead turn out to be alive (the rescue chains will meet this
  ship often).
- **Mining barge**. Slow, huge, and patient; it eats asteroids
  and excretes ore. A refinery that is also a factory and also
  the most dangerous room aboard. Scarcity: spare parts, always.
  Sin: hoarding them, and a hierarchy of who works the dangerous
  shifts.
- **Passenger transport**. Carries people who are not crew:
  cabins, a big mess, a purser's diplomacy. Scarcity: privacy
  and patience. Sin: everything passengers bring aboard: their
  feuds, their appetites at the ration vote, their habit of
  becoming crew, suspects, and council business.

An **Independent** (tramp) archetype is the seventh, deliberately
shapeless option: a generalist table with no signature room and
no characteristic sin, for seeds that roll her. She is the
control group the others are measured against.

### Sizes (three)

Size sets the human scale, which for us is a drama variable
before it is a stat:

- **Small**: about 8 crew. Everyone knows everything; there is
  nowhere to withdraw to; the council can barely fill its seats
  and one death is a constitutional crisis. Brig: 1 cell.
- **Standard**: about 12 crew, the v0 shape. Brig: 2 cells.
- **Large**: about 16 to 18 crew. Departments become places, not
  people; a crew member can be a stranger; gossip takes a day to
  cross the ship, which the comms-and-runners design will feel.
  Brig: 4 cells.

Brig capacity is borrowed directly from Vanguard, where it is a
hull stat (3 cells on a Cutter, 78 on a Battlecruiser): when the
council sentences more people than the brig holds, the sentence
itself has to change, and the chronicle will say why.

### What the archetype bends

- **Compartments.** Each role adds signature rooms to the
  generator's table and re-weights the rest: the barge grows its
  refinery and ore holds; the cutter an armoury beside its brig;
  the transport passenger cabins and a second mess; the surveyor
  a sensor dome and a second lab; the hauler cargo, cargo, and a
  small chapel-quiet room crews invent uses for. The viewer's
  deck generator already speaks room kinds; archetypes will need
  props and floors for the new kinds when they land.
- **Systems.** Signature systems join the ship's system list,
  breakable and sabotageable like the rest: the refinery, the
  sensor array, the grapple arm, the cutting laser, the passenger
  life-support loop. A sabotaged refinery on a barge is a
  different story from a sabotaged recycler anywhere, and the
  difference is the point.
- **Roster.** Role tables re-weight the crew draw: the cutter
  carries a second security officer and no botanist; the barge
  doubles engineers and works a fitter; the surveyor doubles
  scientists and skips the gym's best customer. Within a role,
  officers gain **specialisations** (a drive-tech versus a
  fabricator under "engineer"; a trauma surgeon versus a
  psychiatrist under "medic"), rolled per person, printed on
  their card, and felt in two places: what they are good at, and
  what the council believes they are good at, which are different
  numbers because one of them is a belief.
- **Stores.** The five counters get archetype appetites and
  archetype deaths: the transport eats food at passenger rates
  and dies of hunger with full fuel tanks; the barge dies of
  parts with a hold full of ore it cannot refine; the surveyor's
  air margin matters more than her food, because nobody is
  coming. Starting buffers and production tables are per
  archetype in config.
- **The voyage.** A leg means different things: a trade run with
  a manifest, a survey circuit, a patrol beat, a salvage claim,
  an ore run, a passenger route. The galaxy layer will generate
  encounters against the archetype (patrols inspect haulers for
  contraband and salute cutters; a distress call means something
  different to a salvage rig), and bounties and convoys will be
  drawn as archetyped ships with captains, per the galaxy
  chapter.
- **Capabilities, by construction.** Vanguard gates activities
  by equipment (any hull can mine if it fits a mining laser);
  we have no player to do the fitting, so the archetype is the
  fit: only a barge refines ore into parts (a production path
  the Stores chapter needs), only a surveyor's array reads space
  weather a day early (a telegraph at galaxy scale for the
  storms the feel pass shakes the deck for), only a cutter can
  lawfully hold a prisoner for another ship. Capability is
  identity here, not inventory.

### Manufacturers and factions (deferred to the galaxy chapter)

Vanguard binds factions to hulls through 13 manufacturers
(Mindus builds the best mining ships and sells them only to
Mindus; the police yard's patrol hulls can only be taken by
boarding one). When the galaxy layer is built, archetype
availability, hull naming flavour, and refit access should
follow faction and manufacturer the same way, so a region of
space feels different in the only language a ship game speaks.
Noted here; designed there.

### The viewer

The archetype is identity, so it is displayed like identity:
beside the ship's name in the header and on the banner ("Hauler
· Large"), in the ship's card, and, when the hull exterior view
is built (it is already queued), in the silhouette itself: a
barge is wide and scarred, a cutter is sleek and grey, a
transport is windowed like a lantern. The exterior view takes
its grammar from this chapter.

### Open questions for the build

- Can a witness filter seeds by archetype in the viewer (show me
  a cutter)? Leaning: yes, as a viewer convenience over seed
  search; the seed still decides, the filter just hunts.
- Can an archetype change mid-voyage? A hauler refit into a
  salvage rig at a port is the construction chapter's best story.
  Leaning: allowed only there, slowly, at cost, and the ship
  keeps her old name.
- Do passengers on a transport get council votes through a
  representative? Leaning: no vote, one voice: a passenger
  witness at admissions and rationing sittings, which the
  council can ignore at the usual price.

## The Ship's Council (built Oct 18, 2026)

Stellaris gives a state a council: a ruler and a row of portfolio
holders whose traits bend the whole empire, meeting over an
agenda. The village sim gives the other half of the truth: its
"council" is a court only (elder plus household heads, no
elections, no laws passed), and its verdict machinery is the
finest politics engine in either sim: judges who deduce guilt
from their own beliefs alone, testimony discounted at the ear by
trust in the teller, witnesses who lie to protect their own and
redirect suspicion onto a scapegoat, and verdicts that manufacture
tomorrow's grudges. Aboard ship the two ideas are the same room.
The captain commands between sittings; the council is where
command becomes judgment, and judgment, being made of beliefs,
can be wrong in ways that outlive the meeting.

### Composition: seven seats, worn over roles

The council is not a separate cast. It is seven of the twelve
roles, sitting with portfolio authority (Stellaris's move: the
office matters, not just the person).

- **Captain** (the captain): agenda, tie-break, command between
  sittings.
- **First Officer** (the executive officer): crew welfare,
  discipline, the roster.
- **Chief Engineer** (the chief engineer): the ship's body:
  systems, damage, repair truth.
- **Chief Medical Officer** (the medic): bodies: wounds,
  sickness, fitness, cause of death.
- **Security Chief** (the security officer): investigations,
  evidence, the brig.
- **Science Officer** (the scientist): sensors, samples, the
  unknown.
- **Quartermaster** (the quartermaster): stores, rations, cargo,
  who eats.

The five off-council roles (engineer, cook, botanist, pilot,
navigator) are the crew the council governs and the pool it draws
from. The cook's exclusion is deliberate and load-bearing: the
mess is where the crew's unofficial politics happens, at meals
and in gossip. The cook hears everything and votes on nothing,
which makes the cook the most courted person aboard in a crisis.

**Filling seats.** A seat belongs to its role: whoever holds the
role holds the seat, automatically, the way the village elder
presides by being the elder. There is no election aboard a ship.
But roles fall vacant: when a role-holder dies, is confined, is
relieved, or retires hurt, the **captain appoints** a successor
from the surviving crew, by qualification where there is a choice.
Every appointment is a political act the crew has beliefs about:
promote the captain's friend and the mess notices; pass over the
obvious engineer for a loyalist and engineering notices louder.
An appointment from a shrinking crew is how a botanist ends up
Chief Engineer, and everyone aboard, including the botanist,
knows exactly what that means for the next repair.

**Vacancy.** An empty seat does not block the council; it shrinks
it, and the chronicle names the empty chairs. A vacant portfolio
degrades its domain: no Chief Medical Officer means wounds are
judged by laymen at the inquiry and treated by whoever
volunteers; no Quartermaster means stores counted by someone with
other work, and the counts drift from the truth the way beliefs
do. A sitting with four of seven seats filled is legal. It is
also a symptom, and the crew reads it as one.

**Recusal.** The village rule crosses over in ship clothes: no
officer sits in judgment on a case where they are the accused,
the accuser, the victim, or bonded close to any of them. Where
the village used kinship and household, the ship uses bonds and
department: the Chief Engineer does not judge an accusation
against her own engineer if her bond with him is high enough that
the crew would call it protection. A recused seat stands empty
for that case, and the chronicle notes it, because who steps
aside is information.

### Jurisdiction: what the council decides

The council sits for enumerated business only. Everything not
listed is the captain's alone, which is what makes the listed
things feel like law.

- **Boards of inquiry.** The consequences chapter's inquiry IS a
  council sitting; this chapter gives it its judges. Any death
  convenes one automatically, as the village inquest is convened
  by a body. So do a sabotage discovery above a damage threshold,
  a theft from stores with a named suspect, and any accusation
  the Security Chief certifies as case-ready. The board finds
  cause and, where it believes there is one, culprit;
  consequences flow from the finding, not the truth (brig, put
  off at the next port, restriction from systems, forgiveness),
  exactly as the consequences chapter designs.
- **Rationing.** When a store crosses its worry threshold, the
  Quartermaster proposes a level (full, reduced, strict) and the
  council disposes. The captain may impose emergency rationing
  unilaterally, but it expires: within a day the council must
  ratify it or it lapses, and a council that refuses leaves the
  captain holding the hunger and the blame. Rationing is the
  council's most frequent business and its most remembered; more
  grudges will be born over the water line than over any verdict.
- **Discipline short of inquiry.** Confirmed minor offences the
  Security Chief brings: confinement to quarters, extra duties,
  loss of mess privileges. A Security Chief who brings the same
  botanist before the council every week is building a case in
  public, or conducting a persecution, and the crew's beliefs
  will decide which.
- **Admissions.** Rescued survivors, a discovered stowaway, a
  passenger asking to sign on: the crew-flow chapter's "the crew
  decide from beliefs" lives here. The vote weighs the
  Quartermaster's stores math, the doctor's read of their health,
  Security's read of their story, and everyone's read of the
  stranger's face. Refused: put off at the next port with
  supplies. Admitted: signed on under a probationary eye.
- **Course and port.** The captain navigates; the council decides
  two questions: whether to answer a distress call off the
  planned leg, and whether to put in at an unplanned port. Both
  are stores-and-risk questions wearing navigation clothes.
- **Emergency powers.** On the captain's declaration (reactor
  casualty, hull breach, plague signs), the council may grant
  emergency powers by simple majority: unrestricted system
  access, compulsory duties, stores seizure, confinement without
  hearing. Grants expire in days; renewal is a fresh vote, and
  each renewal is harder to carry than the last.
- **Relief of the captain.** The terminal jurisdiction. Any three
  officers may table a motion of no confidence; it carries on
  five of seven (or two-thirds of sitting officers when seats
  stand empty). The grounds are whatever the officers believe: a
  wrongful verdict the captain forced, rations imposed over the
  council's refusal, a death the inquiry laid at command's door,
  simple accumulated distrust. Carried: the First Officer takes
  command; the relieved captain is confined to quarters or put
  off at the next port, and the ship sails on under a captain
  nobody's beliefs have caught up with yet. A failed motion is
  not free: the movers are marked (the vote is recorded, not
  secret, aboard a ship of twelve) and trust moves accordingly.
  This is the polite mutiny, and the frequency law binds here
  too: a run that produces one should be able to narrate exactly
  why.

### How a vote falls

No officer rolls a die at the table. Each vote is computed from
what the officer believes, in four terms the witness can inspect:

1. **The evidence, as they hold it.** For an inquiry, each
   officer deduces from their own belief store, the village
   method intact: means, opportunity, eyewitness weight,
   corroboration, with testimony discounted by trust in the
   teller. The Security Chief's presentation enters every
   officer's store as testimony; it does not enter as fact. For
   a stores motion, the evidence is the Quartermaster's counters
   as that officer believes them, and counters can be wrong,
   stale, or lied about by a quartermaster protecting his own.
2. **Trust in the people of the motion.** Trust in the accused
   pulls toward acquittal; trust in the accuser and proposer
   pulls toward their motion; distrust is not neutral, it is a
   vote for the other side (in the village deduction, distrust
   itself scores as motive).
3. **Trait and portfolio leanings.** Each seat carries a standing
   bias the chronicle can name: the Chief Medical Officer votes
   the body (a wound pattern she believes accidental outweighs
   three officers' suspicions; on stores she votes health,
   against strict rationing, almost always); the Chief Engineer
   protects the ship, then her department (she will confine a
   saboteur on thinner evidence than anyone, and acquit her own
   engineer on thicker); the Quartermaster counts days of supply
   and votes the arithmetic even when the arithmetic is
   unpopular; the Security Chief votes the case file; the
   Scientist votes uncertainty, abstaining or demanding delay
   when the sensor story is thin; the First Officer votes the
   crew's cohesion, which makes her the swing seat both blocs
   court. Personal traits bend the seat's bias: an empathic
   doctor, a vindictive security chief, a loyalist quartermaster
   are different councils wearing the same seven chairs.
4. **Blocs.** Bonds pull votes together the way household loyalty
   did in the village: an officer strongly bonded to another
   tends to land where they land, and a grudge against the
   proposer is a vote already cast. Two sittings with identical
   evidence and different outcomes because the bonds moved is
   the politics working.

Formally: a motion carries on a simple majority of sitting,
unrecused officers unless stated otherwise (admissions and
emergency powers: simple majority; relief of the captain: the
supermajority above; inquiry findings: majority, with the
strength of the finding scaled by the evidence the median officer
held, so a 4-3 conviction on thin beliefs sentences lighter than
a 7-0 on strong ones). The captain votes only to break a tie,
but holds three powers worth more than a vote: **agenda** (the
captain decides what reaches the table and when; a buried motion
is a chronicle fact), **veto** over discipline and admissions
(never over an inquiry finding, never over relief), exercised at
a trust cost every officer remembers, and **emergency override**
(act first, answer at the next sitting; ratification restores
trust, refusal costs double). A captain who overrides often is
building the case for the terminal motion one sitting at a time,
in public, in the log.

### Politics over time

The council is a slow machine for converting private suspicion
into public fact, and public fact into new private grudges. A
verdict's fallout follows the village pattern with ship names:
the convicted's friends record grievances against the officers
who voted to convict and against whoever chaired; the victim's
side, if the board acquits someone they believe guilty,
accumulates injustice against the accused and against the bench,
and injustice aboard a ship has the same far end it had in the
village: sabotage is the middle of that road, and what the
village called retribution waits at the end of it. Testimony has
weight by portfolio: the doctor on wounds, the engineer on
whether a system could fail that way, the quartermaster on
whether the stores could be short the amount claimed. An officer
caught presenting what the officer beside them believes was a lie
loses the only currency the table runs on, and their next three
true statements land discounted, because testimony discount is
trust arithmetic and trust, once spent at the table, is spent
everywhere.

Power moves between sittings. Appointments after a death let a
captain stack the table over a long voyage, one tragedy at a
time, and the crew's beliefs track it: a council that has never
once voted against its captain is read by the mess as furniture,
and furniture cannot acquit anyone credibly the day the captain
needs the board to clear someone the crew believes guilty.
Legitimacy is a store like the others: it fills slowly, from
findings the crew believes were honest, and it empties in a
single sitting. The stores chapter gave the ship five counters;
the council is the sixth, unnumbered, and the only one that can
hit zero while every tank is full.

### Staging (viewer)

A sitting is a set-piece the deck already knows how to show: the
council convenes in the mess, officers leaving their stations and
crossing the ship to take seats around the mess tables, the
accused standing at the open end with the Security Chief beside
them, witnesses called in from the corridor one at a time and
visibly waiting outside the door when comms are down and word
travels by runner. Testimony is speech bubbles with weight: a
statement the table believes lands as a firm bubble, a discounted
one renders faded, and the witness watching the fade learns what
the discount means without a number ever showing. When the vote
comes, each officer's token rises over their head in turn, in
seat order, so the count is a thing that happens in time and a
4-3 feels different from a 7-0. The captain's veto, when it
comes, is a standing figure and a cut-off gesture and a room that
goes quiet in the way a room can when everyone's next action is
to leave. Then the chronicle writes it up in full: who sat, who
recused themselves and why, what was presented, how each officer
voted and, in the log's god-view margin, what the truth was. The
mess empties. The cook, who heard all of it through the serving
hatch and voted on none of it, starts dinner.

### Open questions for the build

- Does the captain appoint successors freely, or must an
  appointment be ratified at the next sitting? Leaning: free
  appointment; ratification only for the First Officer's seat,
  since that seat is the succession.
- Secret ballot for the relief motion? Leaning: no. Aboard
  twelve people a secret ballot is a fiction everyone sees
  through, and the recorded vote is what makes a failed motion
  cost something.
- Can the council sit with the captain recused and accused? It
  must be able to, or the terminal jurisdiction is decorative.
  The First Officer chairs; the doctor certifies; Security
  presents. Design the captain-as-accused inquiry first and the
  rest of the table inherits it.

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

# Staging the mundane

Direction chapter, Oct 18, 2026. It follows the ruling in
DECISIONS.md ("The mundane is the game"): the routine is the
content. This chapter sets how the viewer presents it. The
problem it answers: the ordinary day currently arrives as text.
The fix is not less routine and not faster routine. The fix is
that the routine becomes visible, and the text steps back.

## The deck carries the day

1. Meals are scenes. During a sitting, crew sit at tables: a
   seated posture in the body dictionary, chairs filled in
   table order, the cook moving between galley and tables,
   steam over the food. A sitting should read from across the
   room without a single word.
2. Work is carried, literally. A member travelling to a repair
   or a fetch carries the thing: a parts crate, a tool case, a
   stores box, drawn in the hands. Empty hands mean a person
   going somewhere; full hands mean a person on an errand, and
   the witness learns the difference in a minute.
3. Free time has furniture. Games are two seated figures
   facing each other over a board. The gym's machines animate
   under their users. A reader sits, book open, in the common
   room. Idleness is staged as specifically as labour.
4. Sleep is a place, not an absence. Bunks show occupancy;
   the night pair's lamps are the only warm light on a dark
   deck; the ship at 03:00 should feel kept, not empty.

## The ship's day ribbon

A thin strip names the rhythm so the witness can keep it too:
the current watch phase, the current block for most of the
crew, and the next beat of the day with its time ("Evening
meal 18:00", "Lights-out 22:00", "Breakfast 07:00"). The
routine is a schedule being kept; the ribbon is how a new
witness learns it in one sitting instead of a week of logs.

## The chronicle steps back

The chronicle becomes a minor channel. Default view:
highlights only - meals, games, bonds and grudges, accusations,
incidents, system trouble, weather turns, firsts. The full log
remains one toggle away, complete and exact; nothing is
deleted, only demoted. Movement, shift changes, and rest
records do not print in highlights. The log stops being the
game's main text and becomes its archive.

## Discipline

Presentation only. The engine does not change for this
chapter; seating, carrying, and furniture states are derived
in the viewer from the state it already receives. New body
postures follow the house rule: a posture is rows in the
string-grid dictionary plus a line in the sprite cache key.
All additions respect the performance pass: sprites cached,
particles capped, nothing allocated per frame.
