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

## Viewer

A viewer is planned as a separate layer that runs the same engine,
mirroring how the reference project separates its viewer from its
simulation. It will live under `viewer/` and will not change engine
code paths. It does not exist yet.
