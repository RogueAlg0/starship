// Entry point that wires a world together: engine, systems in fixed order,
// and invariant checks. The CLIs and the tests both build worlds through
// here, so there is exactly one definition of what a run is.

import {
  UtilitySource,
  type DecisionRecord,
  type DecisionSource,
} from "./decision/decisions.ts";
import { Engine, World, type SimConfig } from "./engine/engine.ts";
import { checkCrewState, createCrew, stepCrew } from "./entities/crew.ts";
import { Ship } from "./world/ship.ts";
import { Weather } from "./world/weather.ts";

export interface BuiltWorld {
  world: World;
  engine: Engine;
  /** Records of the live source; empty when a replay source was supplied. */
  readonly decisions: DecisionRecord[];
  run(ticks: number): void;
}

export function buildWorld(
  config: SimConfig,
  source?: DecisionSource,
): BuiltWorld {
  let world: World;
  // The utility source's noise comes from the "crew" stream. The callback
  // only runs after the world exists, so the forward reference is safe.
  const decisions =
    source ?? new UtilitySource(() => world.rng.get("crew").next());
  world = new World(config, decisions);
  const engine = new Engine(world);

  const ship = new Ship();
  const weather = new Weather();
  const crew = createCrew();

  engine.addSystem({ name: "weather", step: (w) => weather.step(w) });
  engine.addSystem({
    name: "crew",
    step: (w) => stepCrew(w, crew, ship, weather),
  });
  engine.addInvariant("crew state in range", () => checkCrewState(crew, ship));

  return {
    world,
    engine,
    get decisions() {
      return decisions instanceof UtilitySource ? decisions.records : [];
    },
    run(ticks: number) {
      world.emit("run_start", [], { seed: String(config.seed) });
      engine.run(ticks);
    },
  };
}

export interface SimulationOutcome {
  world: World;
  decisions: DecisionRecord[];
}

/** Build a world and run it for the given number of ticks. */
export function runSimulation(
  config: SimConfig,
  ticks: number,
  source?: DecisionSource,
): SimulationOutcome {
  const built = buildWorld(config, source);
  built.run(ticks);
  return { world: built.world, decisions: built.decisions };
}
