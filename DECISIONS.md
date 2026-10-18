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
