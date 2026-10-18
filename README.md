# starship

Working title. A deterministic, headless simulation of a procedural
starship and the crew who live aboard it. The simulation runs itself:
there are no player controls and no orders to give. The player picks a
seed and witnesses. The seed chooses the ship, the crew, and the fate,
and the event log (the ship's chronicle) records what truly happened
while the crew acted on what they believed.

Status: kernel scaffold. The engine, event log, decision machinery, and
replay are in place and tested. Ship generation, real crew, and the
galaxy around the ship are not built yet; the current world is a minimal
scaffold (three rooms, two placeholder crew, one weather system) that
exists to prove the kernel end to end. See DESIGN.md for the full design
and DECISIONS.md for the standing choices.

## Requirements

Node.js 22.18 or later. The CLI runs the TypeScript sources directly
with Node's built-in type stripping, so there is no build step.
`npm install` only adds dev tools: TypeScript, Vitest, and Node types.

```bash
npm install
```

## Running

Simulate a run. With `--out <dir>` this also writes `events.ndjson`,
`decisions.ndjson`, and `summary.json` (the summary records the event
stream hash plus elapsedMs and ticksPerSecond).

```bash
npm run simulate -- --seed 42 --ticks 200 --out runs/seed42
```

Replay a recorded run and check that it reproduces the event stream
exactly:

```bash
npm run replay -- --dir runs/seed42
```

## Tests

```bash
npm test
```

The suite covers determinism (same seed, same hash; RNG stream
independence), purity (a static scan that bans wall-clock and ambient
randomness calls from the engine sources), and replay (a recorded
decision log reproduces the hash; a tampered or truncated log raises a
divergence error). `npm run check` runs the type check and the tests.

## Layout

- `src/sim.ts`: entry point that wires a world together (engine,
  systems in fixed order, invariant checks). CLIs and tests build
  worlds through here.
- `src/cli/`: the simulate and replay command line entries, plus tiny
  argument helpers. This is platform code; the engine never imports it.
- `src/engine/`: the fixed-order tick loop, the World shell, and the
  seeded RNG with named independent streams.
- `src/log/`: the append-only event log and its running stream hash.
- `src/decision/`: decision sources. Agents pick from candidate lists
  through these; the utility source plays live, the replay source plays
  a recorded log back and refuses to improvise.
- `src/scenario/`: configuration. Every tunable number and table lives
  in `config.ts`.
- `src/world/`: the ship and shipboard weather.
- `src/entities/`: crew members and their per-tick behaviour.
- `test/`: the test suites, at the package root like the reference
  layout.

## Viewer

A viewer is planned as a separate layer that runs the same engine,
mirroring how the reference project separates its viewer from its
simulation. It will live under `viewer/` and will not change engine
code paths. It does not exist yet.
