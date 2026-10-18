// Entry point that wires a world together: generation, systems in fixed
// order, and invariant checks. The CLIs and the tests both build worlds
// through here, so there is exactly one definition of what a run is.
//
// Generation draws from the "shipgen" and "crewgen" streams and is part of
// the run: ship_generated and crew_generated are the first events in every
// log, at tick 0, in live runs and replays alike.

import {
  UtilitySource,
  type DecisionRecord,
  type DecisionSource,
} from "./decision/decisions.ts";
import { Engine, World, type SimConfig } from "./engine/engine.ts";
import {
  checkCrewState,
  generateCrew,
  stepCrew,
  type CrewContext,
  type CrewMember,
} from "./entities/crew.ts";
import { stepSociety } from "./perception/beliefs.ts";
import { generateShip, type Ship } from "./world/ship.ts";
import { checkShipState, stepSystems } from "./world/systems.ts";
import { Weather } from "./world/weather.ts";

export interface BuiltWorld {
  world: World;
  engine: Engine;
  ship: Ship;
  crew: CrewMember[];
  /** Records of the live source; empty when a replay source was supplied. */
  readonly decisions: DecisionRecord[];
  /**
   * Advance exactly one tick. The run_start and departure events are
   * emitted on the first step, so a stepped run and a batch run produce
   * the same event stream.
   */
  step(): void;
  run(ticks: number): void;
}

export function buildWorld(
  config: SimConfig,
  source?: DecisionSource,
): BuiltWorld {
  let world: World;
  // The utility source's noise comes from the "crew" stream. The callback
  // only runs after the world exists, so the forward reference is safe.
  // Nothing else may draw from "crew": replay does not draw the noise, so
  // any other use of that stream would diverge between live and replay.
  const decisions =
    source ?? new UtilitySource(() => world.rng.get("crew").next());
  world = new World(config, decisions);
  const engine = new Engine(world);

  const ship = generateShip(world.rng.get("shipgen"));
  const crew = generateCrew(
    world.rng.get("crewgen"),
    ship,
    world.rng.get("routine"),
  );
  const weather = new Weather();
  const ctx: CrewContext = {
    ship,
    weather,
    history: [],
    meal: null,
    lastGameTick: new Map(),
  };

  world.emit("ship_generated", [], {
    name: ship.name,
    rooms: ship.rooms.map((room) => ({
      index: room.index,
      kind: room.kind,
      name: room.name,
      neighbors: room.neighbors,
    })),
    systems: ship.systems.map((system) => ({
      id: system.id,
      name: system.name,
      kind: system.kind,
      room: system.room,
    })),
  });
  world.emit("crew_generated", [], {
    crew: crew.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.title,
      roleKey: member.roleKey,
      traits: member.traits,
      watch: member.watch,
    })),
  });

  engine.addSystem({ name: "weather", step: (w) => weather.step(w) });
  engine.addSystem({ name: "crew", step: (w) => stepCrew(w, crew, ctx) });
  engine.addSystem({ name: "society", step: (w) => stepSociety(w, crew) });
  engine.addSystem({
    name: "systems",
    step: (w) => stepSystems(w, ship, weather, crew),
  });
  engine.addInvariant("crew state in range", () => checkCrewState(crew, ship));
  engine.addInvariant("ship state in range", () => checkShipState(ship));

  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    world.emit("run_start", [], { seed: String(config.seed) });
    world.emit("departure", [], { ship: ship.name });
  };

  return {
    world,
    engine,
    ship,
    crew,
    get decisions() {
      return decisions instanceof UtilitySource ? decisions.records : [];
    },
    step() {
      start();
      engine.step();
    },
    run(ticks: number) {
      start();
      engine.run(ticks);
    },
  };
}

/**
 * A run driven incrementally: the shape the viewer uses. step() advances
 * exactly one tick; world, ship, and crew expose the live state; hash()
 * names the event stream so far.
 */
export interface RunContext {
  readonly world: World;
  readonly engine: Engine;
  readonly ship: Ship;
  readonly crew: CrewMember[];
  /** Records of the live source; empty when a replay source was supplied. */
  readonly decisions: DecisionRecord[];
  /** The current tick (ticks completed so far). */
  readonly tick: number;
  step(): void;
  run(ticks: number): void;
  /** The event-stream hash of everything emitted so far. */
  hash(): string;
}

/** Create a run context without advancing it. */
export function createRun(
  config: SimConfig,
  source?: DecisionSource,
): RunContext {
  const built = buildWorld(config, source);
  return {
    world: built.world,
    engine: built.engine,
    ship: built.ship,
    crew: built.crew,
    get decisions() {
      return built.decisions;
    },
    get tick() {
      return built.world.tick;
    },
    step: () => built.step(),
    run: (ticks: number) => built.run(ticks),
    hash: () => built.world.events.hash(),
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
  const run = createRun(config, source);
  run.run(ticks);
  return { world: run.world, decisions: run.decisions };
}
