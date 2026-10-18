// The engine: a fixed-order tick loop over registered systems.
//
// Systems run in registration order every tick; nothing else decides the
// order of the world. After the systems, registered invariant checks run
// (unless disabled in config) and a violation throws, because a world that
// broke its own rules should stop, not drift.

import { EventLog, type SimEvent } from "../log/events.ts";
import { StreamRegistry } from "./rng.ts";
import type { DecisionSource } from "../decision/decisions.ts";

export interface SimConfig {
  seed: number | string;
  checkInvariants?: boolean;
}

export interface System {
  name: string;
  step: (world: World) => void;
}

export type InvariantCheck = (world: World) => void;

export class World {
  tick = 0;
  readonly config: SimConfig;
  readonly rng: StreamRegistry;
  readonly events: EventLog;
  readonly decisions: DecisionSource;

  constructor(config: SimConfig, decisions: DecisionSource, events?: EventLog) {
    this.config = config;
    this.decisions = decisions;
    this.events = events ?? new EventLog();
    this.rng = new StreamRegistry(config.seed);
  }

  emit(
    type: string,
    actors: readonly string[],
    data: Record<string, unknown>,
  ): SimEvent {
    return this.events.emit(this.tick, type, actors, data);
  }
}

export class Engine {
  readonly world: World;
  private readonly systems: System[] = [];
  private readonly invariants: { name: string; check: InvariantCheck }[] = [];

  constructor(world: World) {
    this.world = world;
  }

  addSystem(system: System): this {
    this.systems.push(system);
    return this;
  }

  addInvariant(name: string, check: InvariantCheck): this {
    this.invariants.push({ name, check });
    return this;
  }

  step(): void {
    for (const system of this.systems) system.step(this.world);
    if (this.world.config.checkInvariants !== false) {
      for (const invariant of this.invariants) {
        try {
          invariant.check(this.world);
        } catch (error) {
          throw new Error(
            `invariant "${invariant.name}" violated at tick ${this.world.tick}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
    this.world.tick++;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }
}
