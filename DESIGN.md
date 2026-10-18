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
