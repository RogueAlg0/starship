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

## Chronicle truth mode

The chronicle renders the event log as a ship's log. The config flag
`chronicle.knowsTruth` defaults to true: sabotage lines name the
culprit, marked as what the log knows and the crew does not.
Accusation lines are always rendered as accusations. Turning the flag
off produces the crew's-eye view, where only discovered damage and
spoken beliefs appear.
