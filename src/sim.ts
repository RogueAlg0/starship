// Entry point that wires a world together: generation, systems in fixed
// order, and invariant checks. The CLIs and the tests both build worlds
// through here, so there is exactly one definition of what a run is.
//
// Generation draws from the "shipgen", "crewgen", "galaxy", and "traffic"
// streams and is part of the run: ship_generated and crew_generated are the
// first events in every log, at tick 0, in live runs and replays alike.

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
import { r3 } from "./log/events.ts";
import {
  checkVoyageState,
  generateSector,
  Voyage,
  type Sector,
} from "./world/galaxy.ts";
import {
  checkTrafficState,
  generateTraffic,
  Traffic,
} from "./world/traffic.ts";
import { generateShip, type Ship } from "./world/ship.ts";
import {
  checkStoresState,
  createStores,
  stepStores,
  type StoresState,
} from "./world/stores.ts";
import {
  checkDutiesState,
  createDuties,
  stepDuties,
} from "./world/duties.ts";
import {
  checkCouncilState,
  createCouncil,
  stepCouncil,
  type CouncilState,
} from "./world/council.ts";
import {
  checkFactionState,
  createFactionStanding,
  stepFactionStanding,
  type FactionStanding,
} from "./world/factions.ts";
import {
  checkSectorState,
  createSectorState,
  stepSector,
  type SectorState,
} from "./world/sector.ts";
import {
  checkPortfallState,
  createPortfallState,
  stepPortfall,
  type PortfallState,
} from "./world/portfall.ts";
import {
  checkHealthState,
  createHealthState,
  stepHealth,
  type HealthState,
} from "./world/health.ts";
import { stepSkills } from "./world/skills.ts";
import { checkShipState, stepSystems } from "./world/systems.ts";
import { Weather } from "./world/weather.ts";

export interface BuiltWorld {
  world: World;
  engine: Engine;
  ship: Ship;
  crew: CrewMember[];
  /** The sector this voyage crosses, the leg being sailed, and
   *  the other ships under way in the sector. */
  galaxy: { sector: Sector; voyage: Voyage; traffic: Traffic };
  /** What the ship eats, burns, and breathes: the five stores. */
  stores: StoresState;
  /** Bodies, harm, and the cause ledger (the Consequences chapter). */
  health: HealthState;
  /** The Ship's Council: seats, sittings, legitimacy. */
  council: CouncilState;
  /** The ship's reputation with each galactic faction. */
  standing: FactionStanding;
  /** The sector game: influence, contests and conditions at the ports. */
  sectorState: SectorState;
  /** PORTFALL collections, provenance, and the mess league. */
  portfall: PortfallState;
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
  // The galaxy draws last among the generators and only from its
  // own stream: the sector a seed sails is fixed at build, like
  // the ship and the crew, and no later system can shift it.
  const sector = generateSector(world.rng.get("galaxy"));
  const voyage = new Voyage(world.rng.get("galaxy"), sector);
  // Traffic draws from its own stream, like everything else, and
  // is generated whole: the sector's other ships and their entire
  // schedules exist before the first tick, and no tick ever draws
  // for them again.
  const traffic = new Traffic(
    sector,
    generateTraffic(world.rng.get("traffic"), sector, ship.name),
    voyage,
  );
  // Stores are loaded at departure: fixed quantities in config,
  // no draws, so the loading cannot shift any other stream.
  const stores = createStores(crew.length);
  ship.stores = stores;
  // Duties likewise: fixed starting levels, no draws.
  ship.duties = createDuties();
  // Bodies and the council draw nothing at generation: health is
  // state the tick loop accrues, and the council's seats follow
  // the roster's roles. Neither can shift another stream.
  const health = createHealthState();
  const council = createCouncil(crew);
  const standing = createFactionStanding(sector);
  const sectorState = createSectorState(sector);
  // PORTFALL collections likewise: empty ledgers, no draws.
  const portfall = createPortfallState(crew);
  ship.councilPublic = { cmoFilled: true, emergencyUntil: -1, acting: {} };
  const weather = new Weather();
  const ctx: CrewContext = {
    ship,
    weather,
    voyage,
    history: [],
    meal: null,
    lastGameTick: new Map(),
    portfall,
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
      passion: member.skills.passion,
      boarding: member.skills.boarding,
    })),
  });

  engine.addSystem({ name: "weather", step: (w) => weather.step(w) });
  engine.addSystem({ name: "voyage", step: (w) => voyage.step(w) });
  engine.addSystem({ name: "traffic", step: (w) => traffic.step(w) });
  engine.addSystem({
    name: "stores",
    step: (w) => stepStores(w, ship, crew, { sector, voyage, traffic }),
  });
  engine.addSystem({
    name: "portfall",
    step: (w) => stepPortfall(w, portfall, crew, { sector, voyage, sectorState }),
  });
  engine.addSystem({ name: "crew", step: (w) => stepCrew(w, crew, ctx) });
  engine.addSystem({ name: "society", step: (w) => stepSociety(w, crew) });
  engine.addSystem({
    name: "systems",
    step: (w) => stepSystems(w, ship, weather, crew),
  });
  engine.addSystem({ name: "duties", step: (w) => stepDuties(w, ship) });
  engine.addSystem({
    name: "health",
    step: (w) => stepHealth(w, health, ship, crew, weather),
  });
  engine.addSystem({ name: "skills", step: (w) => stepSkills(w, crew) });
  engine.addSystem({
    name: "council",
    step: (w) =>
      stepCouncil(w, council, ship, crew, health, stores, { sector, voyage }),
  });
  engine.addSystem({
    name: "factions",
    step: (w) => {
      stepFactionStanding(w, standing, sector);
      stepSector(w, sectorState, sector);
    },
  });
  engine.addInvariant("crew state in range", () => checkCrewState(crew, ship));
  engine.addInvariant("ship state in range", () => checkShipState(ship));
  engine.addInvariant("duty levels in range", () => checkDutiesState(ship));
  engine.addInvariant("voyage state in range", () =>
    checkVoyageState(voyage, world.tick),
  );
  engine.addInvariant("traffic contact state matches geometry", () =>
    checkTrafficState(traffic, voyage, world.tick),
  );
  engine.addInvariant("stores within their tanks", () =>
    checkStoresState(stores),
  );
  engine.addInvariant("bodies and ledgers reconcile", () =>
    checkHealthState(crew),
  );
  engine.addInvariant("council state in range", () =>
    checkCouncilState(council, crew),
  );
  engine.addInvariant("faction standing in range", () =>
    checkFactionState(sector, standing),
  );
  engine.addInvariant("sector influence in range", () =>
    checkSectorState(sector, sectorState),
  );
  engine.addInvariant("portfall state in range", () =>
    checkPortfallState(portfall, crew),
  );

  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    world.emit("run_start", [], { seed: String(config.seed) });
    world.emit("departure", [], {
      ship: ship.name,
      from: voyage.originPort.name,
      to: voyage.destinationPort.name,
      distance: r3(voyage.distanceLightDays),
      days: r3(voyage.legDays),
    });
  };

  return {
    world,
    engine,
    ship,
    crew,
    galaxy: { sector, voyage, traffic },
    stores,
    health,
    council,
    standing,
    sectorState,
    portfall,
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
  /** The sector this voyage crosses, the leg being sailed, and
   *  the other ships under way in the sector. */
  readonly galaxy: { sector: Sector; voyage: Voyage; traffic: Traffic };
  /** What the ship eats, burns, and breathes: the five stores. */
  readonly stores: StoresState;
  /** Bodies, harm, and the cause ledger (the Consequences chapter). */
  readonly health: HealthState;
  /** The Ship's Council: seats, sittings, legitimacy. */
  readonly council: CouncilState;
  /** The ship's reputation with each galactic faction. */
  readonly standing: FactionStanding;
  /** The sector game: influence, contests and conditions at the ports. */
  readonly sectorState: SectorState;
  /** PORTFALL collections, provenance, and the mess league. */
  readonly portfall: PortfallState;
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
    galaxy: built.galaxy,
    stores: built.stores,
    health: built.health,
    council: built.council,
    standing: built.standing,
    sectorState: built.sectorState,
    portfall: built.portfall,
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
